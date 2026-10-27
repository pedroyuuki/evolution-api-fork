import { PrismaRepository } from '@api/repository/repository.service';
import { WAMonitoringService } from '@api/services/monitor.service';
import { Auth, configService, Cors, Log, Websocket } from '@config/env.config';
import { Logger } from '@config/logger.config';
import { Server } from 'http';
import { Server as SocketIO, Socket } from 'socket.io';

import { EmitData, EventController, EventControllerInterface } from '../event.controller';
import { canUseInstance, resolvePrincipal, SocketPrincipal } from './websocket-access';

const GLOBAL_EVENTS_ROOM = 'global-events';

export class WebsocketController extends EventController implements EventControllerInterface {
  private io: SocketIO;
  private corsConfig: Array<any>;
  private readonly logger = new Logger('WebsocketController');

  constructor(prismaRepository: PrismaRepository, waMonitor: WAMonitoringService) {
    super(prismaRepository, waMonitor, configService.get<Websocket>('WEBSOCKET')?.ENABLED, 'websocket');

    this.cors = configService.get<Cors>('CORS').ORIGIN;
  }

  public init(httpServer: Server): void {
    if (!this.status) {
      return;
    }

    this.socket = new SocketIO(httpServer, {
      cors: { origin: this.cors },
      allowRequest: async (req, callback) => {
        try {
          const url = new URL(req.url || '', 'http://localhost');
          const principal = await this.principalOf(
            url.searchParams.get('apikey') || (req.headers.apikey as string),
            req.socket.remoteAddress,
          );

          if (!principal) {
            this.logger.error('Connection rejected: invalid apiKey');
            return callback('Invalid apiKey', false);
          }

          callback(null, true);
        } catch (error) {
          this.logger.error('Authentication error:');
          this.logger.error(error);
          callback('Authentication error', false);
        }
      },
    });

    // O handshake só diz que o token existe; cada conexão guarda DE QUEM ele é, e o namespace
    // de uma instância só aceita o token dela ou o global.
    const identify = async (socket: Socket, next: (err?: Error) => void) => {
      try {
        const apiKey = (socket.handshake.query?.apikey as string) || (socket.handshake.headers?.apikey as string);
        socket.data.principal = await this.principalOf(apiKey, socket.handshake.address);
        if (!socket.data.principal) return next(new Error('Invalid apiKey'));

        const instanceName = socket.nsp.name.slice(1);
        if (socket.nsp.name !== '/' && !canUseInstance(socket.data.principal, instanceName)) {
          this.logger.error(`Connection rejected: apiKey is not from instance ${instanceName}`);
          return next(new Error('apiKey is not from this instance'));
        }
        next();
      } catch (error) {
        next(error as Error);
      }
    };
    this.socket.use(identify);
    this.socket.of(/^\/.+$/).use(identify);

    this.socket.on('connection', (socket) => {
      this.logger.info('User connected');

      // Eventos globais (WEBSOCKET_GLOBAL_EVENTS) trazem todas as instâncias: só para o token global.
      if ((socket.data.principal as SocketPrincipal)?.global) socket.join(GLOBAL_EVENTS_ROOM);

      socket.on('disconnect', () => {
        this.logger.info('User disconnected');
      });

      socket.on('sendNode', async (data) => {
        try {
          if (!canUseInstance(socket.data.principal, data?.instanceId)) {
            this.logger.error(`sendNode rejected: apiKey is not from instance ${data?.instanceId}`);
            return;
          }
          await this.waMonitor.waInstances[data.instanceId].baileysSendNode(data.stanza);
          this.logger.info('Node sent successfully');
        } catch (error) {
          this.logger.error('Error sending node:');
          this.logger.error(error);
        }
      });
    });

    this.logger.info('Socket.io initialized');
  }

  private async principalOf(apiKey: string | undefined, remoteAddress: string | undefined) {
    return resolvePrincipal({
      apiKey,
      remoteAddress,
      allowedHosts: configService.get<Websocket>('WEBSOCKET').ALLOWED_HOSTS || '127.0.0.1,::1,::ffff:127.0.0.1',
      globalKey: configService.get<Auth>('AUTHENTICATION').API_KEY.KEY,
      findInstanceNameByToken: async (token) =>
        (await this.prismaRepository.instance.findFirst({ where: { token }, select: { name: true } }))?.name ?? null,
    });
  }

  private set cors(cors: Array<any>) {
    this.corsConfig = cors;
  }

  private get cors(): string | Array<any> {
    return this.corsConfig?.includes('*') ? '*' : this.corsConfig;
  }

  private set socket(socket: SocketIO) {
    this.io = socket;
  }

  public get socket(): SocketIO {
    return this.io;
  }

  public async emit({
    instanceName,
    origin,
    event,
    data,
    serverUrl,
    dateTime,
    sender,
    apiKey,
    integration,
    extra,
  }: EmitData): Promise<void> {
    if (integration && !integration.includes('websocket')) {
      return;
    }

    if (!this.status) {
      return;
    }

    const configEv = event.replace(/[.-]/gm, '_').toUpperCase();
    const logEnabled = configService.get<Log>('LOG').LEVEL.includes('WEBSOCKET');
    const message = {
      ...(extra ?? {}),
      event,
      instance: instanceName,
      data,
      server_url: serverUrl,
      date_time: dateTime,
      sender,
      apikey: apiKey,
    };

    if (configService.get<Websocket>('WEBSOCKET')?.GLOBAL_EVENTS) {
      this.socket.to(GLOBAL_EVENTS_ROOM).emit(event, message);

      if (logEnabled) {
        this.logger.log({ local: `${origin}.sendData-WebsocketGlobal`, ...message });
      }
    }

    try {
      const instance = await this.get(instanceName);

      if (!instance?.enabled) {
        return;
      }

      if (Array.isArray(instance?.events) && instance?.events.includes(configEv)) {
        this.socket.of(`/${instanceName}`).emit(event, message);

        if (logEnabled) {
          this.logger.log({ local: `${origin}.sendData-Websocket`, ...message });
        }
      }
    } catch (err) {
      if (logEnabled) {
        this.logger.log(err);
      }
    }
  }
}
