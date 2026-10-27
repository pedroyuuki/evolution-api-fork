import { PrismaRepository } from '@api/repository/repository.service';
import { WAMonitoringService } from '@api/services/monitor.service';
import { Integration } from '@api/types/wa.types';
import { Logger } from '@config/logger.config';

import { ChannelController, ChannelControllerInterface } from '../channel.controller';

export class EvolutionController extends ChannelController implements ChannelControllerInterface {
  private readonly logger = new Logger('EvolutionController');

  constructor(prismaRepository: PrismaRepository, waMonitor: WAMonitoringService) {
    super(prismaRepository, waMonitor);
  }

  integrationEnabled: boolean;

  public async receiveWebhook(data: any) {
    const numberId = data.numberId;

    if (!numberId) {
      this.logger.error('WebhookService -> receiveWebhookEvolution -> numberId not found');
      return;
    }

    // Só instâncias do canal Evolution: o mesmo número pode ser de uma instância Baileys, e o
    // connectToWhatsapp(data) dela abriria um socket novo (reconexão forçada sem autenticação).
    const instance = await this.prismaRepository.instance.findFirst({
      where: { number: numberId, integration: Integration.EVOLUTION },
    });

    if (!instance) {
      this.logger.error('WebhookService -> receiveWebhook -> instance not found');
      return;
    }

    await this.waMonitor.waInstances[instance.name].connectToWhatsapp(data);

    return {
      status: 'success',
    };
  }
}
