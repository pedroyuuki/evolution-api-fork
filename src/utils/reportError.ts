import { Auth, configService, HttpServer, Sentry as SentryConfig, Webhook } from '@config/env.config';
import { Logger } from '@config/logger.config';
import * as Sentry from '@sentry/node';
import axios from 'axios';

const logger = new Logger('ErrorReport');

/**
 * As exceções HTTP do projeto (BadRequestException e afins) lançam objetos literais, não
 * instâncias de Error; sem isto o relatório viraria "[object Object]".
 */
export function describeError(error: unknown): string {
  if (error instanceof Error) return error.stack ?? error.message;
  if (typeof error === 'string') return error;

  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

type ErrorFields = { error?: string; message?: string; status?: number };

/**
 * Envia o erro ao WEBHOOK_EVENTS_ERRORS_WEBHOOK, no formato que o middleware de erro do
 * Express sempre usou. Nunca lança: falha ao avisar não pode virar outro erro.
 */
export function notifyErrorWebhook(fields: ErrorFields): void {
  const webhook = configService.get<Webhook>('WEBHOOK');
  if (!webhook.EVENTS.ERRORS || !webhook.EVENTS.ERRORS_WEBHOOK) return;

  const tzoffset = new Date().getTimezoneOffset() * 60000;
  const errorData = {
    event: 'error',
    data: {
      error: fields.error || 'Internal Server Error',
      message: fields.message || 'Internal Server Error',
      status: fields.status || 500,
      response: {
        message: fields.message || 'Internal Server Error',
      },
    },
    date_time: new Date(Date.now() - tzoffset).toISOString(),
    api_key: configService.get<Auth>('AUTHENTICATION').API_KEY.KEY,
    server_url: configService.get<HttpServer>('SERVER').URL,
  };

  logger.error(errorData);

  axios
    .post(webhook.EVENTS.ERRORS_WEBHOOK, errorData)
    .catch((error) => logger.warn(`Falha ao enviar o erro ao ERRORS_WEBHOOK: ${error?.message ?? error}`));
}

function sentryEnabled(): boolean {
  return Boolean(configService.get<SentryConfig>('SENTRY')?.DSN);
}

/** Erro de uma requisição HTTP, chamado pelo middleware de erro do Express. */
export function reportHttpError(error: any): void {
  if (sentryEnabled() && (error?.status ?? 500) >= 500) {
    Sentry.captureException(error);
  }
  notifyErrorWebhook({ error: error?.error, message: error?.message, status: error?.status });
}

/**
 * Erro de trabalho que roda fora de uma requisição (filas, webhooks já respondidos). Sem
 * isto ele só existiria no log do container: o middleware do Express nunca o vê.
 */
export function reportBackgroundError(source: string, error: unknown): void {
  const message = `${source}: ${describeError(error)}`;
  logger.error(message);

  if (sentryEnabled()) {
    Sentry.captureException(error instanceof Error ? error : new Error(message), { tags: { source } });
  }
  notifyErrorWebhook({ error: 'Background Task Error', message, status: 500 });
}
