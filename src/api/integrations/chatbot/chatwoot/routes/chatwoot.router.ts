import { RouterBroker } from '@api/abstract/abstract.router';
import { InstanceDto } from '@api/dto/instance.dto';
import { chatwootWebhookDispatcher, instanceExists } from '@api/integrations/chatbot/chatwoot/chatwoot-webhook';
import { ChatwootDto } from '@api/integrations/chatbot/chatwoot/dto/chatwoot.dto';
import { HttpStatus } from '@api/routes/index.router';
import { chatwootController } from '@api/server.module';
import { Chatwoot, configService } from '@config/env.config';
import { chatwootSchema, instanceSchema } from '@validate/validate.schema';
import { RequestHandler, Router } from 'express';

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
        // O que dá para saber na hora responde com erro na hora: é o único caminho para o
        // Chatwoot marcar a mensagem como falha (não há API para marcar depois).
        const { instanceName } = req.params;

        if (!configService.get<Chatwoot>('CHATWOOT').ENABLED || !chatwootWebhookDispatcher) {
          return res.status(HttpStatus.BAD_REQUEST).json({ status: 'chatwoot disabled' });
        }
        if (!(await instanceExists(instanceName))) {
          return res.status(HttpStatus.NOT_FOUND).json({ status: `instance ${instanceName} not found` });
        }

        // Grava antes de responder: a partir daqui a entrega é responsabilidade da Evolution.
        const result = await chatwootWebhookDispatcher.accept(instanceName, req.body);
        if (result === 'stopping') {
          return res.status(HttpStatus.SERVICE_UNAVAILABLE).json({ status: 'shutting down' });
        }

        res.status(HttpStatus.OK).json({ status: result });
      });
  }

  public readonly router: Router = Router();
}
