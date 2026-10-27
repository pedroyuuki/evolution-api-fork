import { InstanceDto } from '@api/dto/instance.dto';

/** Campos que identificam a instância: só podem vir do path, que é o que os guards validaram. */
const IDENTITY_FIELDS = ['instanceName', 'instanceId'];

/**
 * Monta o InstanceDto da rota. Antes a query era copiada por cima de `req.params` depois
 * dos guards: `/message/sendText/A?instanceName=B` com o token de A agia na instância B.
 * A query continua valendo para os demais campos, mas nunca para a identidade.
 */
export function resolveInstanceParams(
  params: Record<string, any>,
  query: Record<string, any> | undefined,
  body: any,
  isCreateRoute: boolean,
): InstanceDto {
  const fromQuery = { ...(query ?? {}) };
  // Com a instância no path (o que o guard validou), a query não pode trocá-la. Sem ela no
  // path (só /instance/fetchInstances e /instance/create passam pelos guards assim), a query
  // é o filtro: o manager pede `fetchInstances?instanceId=` com a chave global, e com token
  // de instância o controller já filtra pelo token.
  if (params?.instanceName !== undefined) {
    for (const field of IDENTITY_FIELDS) delete fromQuery[field];
  }

  const instance = { ...fromQuery, ...params } as InstanceDto;

  // No create a instância ainda não existe: os dados dela vêm do body (guardado pela chave global).
  if (isCreateRoute) Object.assign(instance, body);

  return instance;
}
