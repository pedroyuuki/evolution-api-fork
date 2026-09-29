// Import this first from sentry instrument!
import '@utils/instrumentSentry';

// Now import other modules
import { chatwootWebhookDispatcher } from '@api/integrations/chatbot/chatwoot/chatwoot-webhook';
import { ProviderFiles } from '@api/provider/sessions';
import { PrismaRepository } from '@api/repository/repository.service';
import { HttpStatus, router } from '@api/routes/index.router';
import { eventManager, waMonitor } from '@api/server.module';
import { configService, Cors, HttpServer, ProviderSession, Sentry as SentryConfig } from '@config/env.config';
import { onUnexpectedError } from '@config/error.config';
import { Logger } from '@config/logger.config';
import { ROOT_DIR } from '@config/path.config';
import * as Sentry from '@sentry/node';
import { reportHttpError } from '@utils/reportError';
import { ServerUP } from '@utils/server-up';
import compression from 'compression';
import cors from 'cors';
import express, { json, NextFunction, Request, Response, urlencoded } from 'express';
import { join } from 'path';

async function initWA() {
  await waMonitor.loadInstance();
}

async function bootstrap() {
  const logger = new Logger('SERVER');
  const app = express();

  let providerFiles: ProviderFiles = null;
  if (configService.get<ProviderSession>('PROVIDER').ENABLED) {
    providerFiles = new ProviderFiles(configService);
    await providerFiles.onModuleInit();
    logger.info('Provider:Files - ON');
  }

  const prismaRepository = new PrismaRepository(configService);
  await prismaRepository.onModuleInit();

  app.use(
    cors({
      origin(requestOrigin, callback) {
        const { ORIGIN } = configService.get<Cors>('CORS');
        if (ORIGIN.includes('*')) {
          return callback(null, true);
        }
        if (ORIGIN.indexOf(requestOrigin) !== -1) {
          return callback(null, true);
        }
        return callback(new Error('Not allowed by CORS'));
      },
      methods: [...configService.get<Cors>('CORS').METHODS],
      credentials: configService.get<Cors>('CORS').CREDENTIALS,
    }),
    urlencoded({ extended: true, limit: '136mb' }),
    json({ limit: '136mb' }),
    compression(),
  );

  app.set('view engine', 'hbs');
  app.set('views', join(ROOT_DIR, 'views'));
  app.use(express.static(join(ROOT_DIR, 'public')));

  app.use('/store', express.static(join(ROOT_DIR, 'store')));

  app.use('/', router);

  app.use(
    (err: Error, req: Request, res: Response, next: NextFunction) => {
      if (err) {
        // Sentry e ERRORS_WEBHOOK. O handler do Sentry registrado abaixo nunca recebia estes
        // erros: este middleware responde e não repassa o erro adiante.
        reportHttpError(err);

        return res.status(err['status'] || 500).json({
          status: err['status'] || 500,
          error: err['error'] || 'Internal Server Error',
          response: {
            message: err['message'] || 'Internal Server Error',
          },
        });
      }

      next();
    },
    (req: Request, res: Response, next: NextFunction) => {
      const { method, url } = req;

      res.status(HttpStatus.NOT_FOUND).json({
        status: HttpStatus.NOT_FOUND,
        error: 'Not Found',
        response: {
          message: [`Cannot ${method.toUpperCase()} ${url}`],
        },
      });

      next();
    },
  );

  const httpServer = configService.get<HttpServer>('SERVER');

  ServerUP.app = app;
  let server = ServerUP[httpServer.TYPE];

  if (server === null) {
    logger.warn('SSL cert load failed — falling back to HTTP.');
    logger.info("Ensure 'SSL_CONF_PRIVKEY' and 'SSL_CONF_FULLCHAIN' env vars point to valid certificate files.");

    httpServer.TYPE = 'http';
    server = ServerUP[httpServer.TYPE];
  }

  eventManager.init(server);

  const sentryConfig = configService.get<SentryConfig>('SENTRY');
  if (sentryConfig.DSN) {
    logger.info('Sentry - ON');

    // Add this after all routes,
    // but before any and other error-handling middlewares are defined
    Sentry.setupExpressErrorHandler(app);
  }

  server.listen(httpServer.PORT, () => logger.log(httpServer.TYPE.toUpperCase() + ' - ON: ' + httpServer.PORT));

  initWA().catch((error) => {
    logger.error('Error loading instances: ' + error);
  });

  // Webhooks do Chatwoot que um processo anterior aceitou e não terminou (deploy, queda):
  // são retomados assim que cada instância conectar.
  chatwootWebhookDispatcher
    ?.recover()
    .then((count) => count && logger.info(`Chatwoot: ${count} webhook(s) pendente(s) retomado(s)`))
    .catch((error) => logger.error(`Chatwoot: falha ao retomar webhooks pendentes: ${error}`));

  registerGracefulShutdown(logger);

  onUnexpectedError();
}

/** Prazo para terminar o trabalho em andamento: abaixo dos 10s do docker stop. */
const SHUTDOWN_DRAIN_MS = 8_000;

/**
 * No SIGTERM (docker stop, deploy) para de aceitar webhooks do Chatwoot e espera os que
 * estão em andamento. O que não terminar continua gravado no Redis e é retomado ao subir.
 */
function registerGracefulShutdown(logger: Logger) {
  let shuttingDown = false;

  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;

    logger.warn(`${signal} recebido: finalizando`);
    try {
      if (chatwootWebhookDispatcher) {
        const inFlight = chatwootWebhookDispatcher.inFlight;
        const drained = await chatwootWebhookDispatcher.stop(SHUTDOWN_DRAIN_MS);
        if (inFlight) {
          logger.warn(
            drained
              ? `Chatwoot: ${inFlight} webhook(s) em andamento concluído(s)`
              : 'Chatwoot: prazo esgotado; os webhooks restantes serão retomados ao subir',
          );
        }
      }
      if (configService.get<SentryConfig>('SENTRY').DSN) {
        await Sentry.close(1_000);
      }
    } finally {
      process.exit(0);
    }
  };

  process.once('SIGTERM', () => void shutdown('SIGTERM'));
  process.once('SIGINT', () => void shutdown('SIGINT'));
}

bootstrap();
