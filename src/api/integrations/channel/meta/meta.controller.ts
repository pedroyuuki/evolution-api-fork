import { PrismaRepository } from '@api/repository/repository.service';
import { WAMonitoringService } from '@api/services/monitor.service';
import { Integration } from '@api/types/wa.types';
import { configService, Database } from '@config/env.config';
import { Logger } from '@config/logger.config';
import axios from 'axios';

import { ChannelController, ChannelControllerInterface } from '../channel.controller';
import { pickPrimaryInstance, shouldWarnDuplicate } from './instance-routing';
import { payloadForEntry } from './split-webhook';

export class MetaController extends ChannelController implements ChannelControllerInterface {
  private readonly logger = new Logger('MetaController');
  private readonly duplicateWarned = new Map<string, number>();

  constructor(prismaRepository: PrismaRepository, waMonitor: WAMonitoringService) {
    super(prismaRepository, waMonitor);
  }

  integrationEnabled: boolean;

  /**
   * Instância do número do evento. Com mais de uma instância com o mesmo phone_number_id
   * (ex.: a instância de disparo criada ao lado da original), status vão para a que enviou
   * a mensagem e o resto (mensagens recebidas) para a mais antiga.
   */
  private async resolveInstance(numberId: string, entry: any) {
    const candidates = await this.prismaRepository.instance.findMany({
      where: { number: numberId, integration: Integration.WHATSAPP_BUSINESS },
      select: { id: true, name: true, createdAt: true },
    });
    const primary = pickPrimaryInstance(candidates);
    if (candidates.length < 2) return primary;

    if (shouldWarnDuplicate(numberId, Date.now(), this.duplicateWarned)) {
      this.logger.warn(
        `Número ${numberId} está em ${candidates.length} instâncias (${candidates.map((c) => c.name).join(', ')}); ` +
          `mensagens recebidas vão para ${primary.name}, status para a instância que enviou`,
      );
    }

    const statusId = entry?.changes?.[0]?.value?.statuses?.[0]?.id;
    if (!statusId) return primary;
    for (const candidate of candidates) {
      if (await this.hasMessage(candidate.id, statusId)) return candidate;
    }
    return primary;
  }

  private async hasMessage(instanceId: string, keyId: string): Promise<boolean> {
    if (configService.get<Database>('DATABASE').PROVIDER === 'mysql') {
      return !!(await this.prismaRepository.message.findFirst({
        where: { instanceId, key: { path: ['id'], equals: keyId } },
        select: { id: true },
      }));
    }
    const rows = (await this.prismaRepository.$queryRaw`
      SELECT 1 FROM "Message" WHERE "instanceId" = ${instanceId} AND "key"->>'id' = ${keyId} LIMIT 1
    `) as unknown[];
    return rows.length > 0;
  }

  public async receiveWebhook(data: any) {
    if (data.object === 'whatsapp_business_account') {
      if (data.entry[0]?.changes[0]?.field === 'message_template_status_update') {
        const template = await this.prismaRepository.template.findFirst({
          where: { templateId: `${data.entry[0].changes[0].value.message_template_id}` },
        });

        if (!template) {
          console.log('template not found');
          return;
        }

        const { webhookUrl } = template;

        await axios.post(webhookUrl, data.entry[0].changes[0].value, {
          headers: {
            'Content-Type': 'application/json',
          },
        });
        return;
      }

      data.entry?.forEach(async (entry: any) => {
        const numberId = entry.changes[0].value.metadata.phone_number_id;

        if (!numberId) {
          this.logger.error('WebhookService -> receiveWebhookMeta -> numberId not found');
          return {
            status: 'success',
          };
        }

        const instance = await this.resolveInstance(numberId, entry);

        if (!instance) {
          this.logger.error('WebhookService -> receiveWebhookMeta -> instance not found');
          return {
            status: 'success',
          };
        }

        await this.waMonitor.waInstances[instance.name].connectToWhatsapp(payloadForEntry(data, entry));

        return {
          status: 'success',
        };
      });
    }

    return {
      status: 'success',
    };
  }
}
