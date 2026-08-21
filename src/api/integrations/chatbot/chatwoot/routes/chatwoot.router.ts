import { RouterBroker } from '@api/abstract/abstract.router';
import { InstanceDto } from '@api/dto/instance.dto';
import { ChatwootDto } from '@api/integrations/chatbot/chatwoot/dto/chatwoot.dto';
import { SerialQueue } from '@api/integrations/chatbot/chatwoot/utils/serial-queue';
import { HttpStatus } from '@api/routes/index.router';
import { chatwootController } from '@api/server.module';
import { Logger } from '@config/logger.config';
import { chatwootSchema, instanceSchema } from '@validate/validate.schema';
import { RequestHandler, Router } from 'express';

const logger = new Logger('ChatwootWebhookQueue');

/**
 * As exceções HTTP do projeto (BadRequestException e afins) lançam objetos literais, não
 * instâncias de Error. Como a resposta já foi enviada, este log é o único diagnóstico
 * que sobra — ele não pode virar "[object Object]".
 */
const describeError = (error: unknown): string => {
  if (error instanceof Error) return error.stack ?? error.message;
  if (typeof error === 'string') return error;

  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
};

const webhookQueue = new SerialQueue((key, error) => logger.error(`[${key}] ${describeError(error)}`));

export class ChatwootRouter extends RouterBroker {
  constructor(...guards: RequestHandler[]) {
    super();
    this.router
      .post(this.routerPath('set'), ...guards, async (req, res) => {
        const response = await this.dataValidate<ChatwootDto>({
          request: req,
          schema: chatwootSchema,
          ClassRef: ChatwootDto,
          execute: (instance, data) => chatwootController.createChatwoot(instance, data),
        });

        res.status(HttpStatus.CREATED).json(response);
      })
      .get(this.routerPath('find'), ...guards, async (req, res) => {
        const response = await this.dataValidate<InstanceDto>({
          request: req,
          schema: instanceSchema,
          ClassRef: InstanceDto,
          execute: (instance) => chatwootController.findChatwoot(instance),
        });

        res.status(HttpStatus.OK).json(response);
      })
      .post(this.routerPath('webhook'), async (req, res) => {
        // O Chatwoot abandona a requisição em 5s (timeout fixo em lib/webhooks/trigger.rb)
        // e marca a mensagem como falha, mesmo quando o envio deu certo. Respondemos de
        // imediato e processamos fora do ciclo da requisição, serializado por conversa
        // para que mensagens consecutivas do atendente não invertam.
        res.status(HttpStatus.OK).json({ status: 'accepted' });

        // message_created traz a conversa em body.conversation.id; conversation_status_changed
        // envia a própria conversa na raiz, e cair no balde 'global' serializaria eventos de
        // conversas distintas atrás uns dos outros.
        const conversationId = req.body?.conversation?.id ?? req.body?.id ?? 'global';
        const key = `${req.params.instanceName}:${conversationId}`;

        // A própria fila reporta descarte por lotação através do handler de erro.
        webhookQueue.enqueue(key, () =>
          this.dataValidate<InstanceDto>({
            request: req,
            schema: instanceSchema,
            ClassRef: InstanceDto,
            execute: (instance, data) => chatwootController.receiveWebhook(instance, data),
          }),
        );
      });
  }

  public readonly router: Router = Router();
}
