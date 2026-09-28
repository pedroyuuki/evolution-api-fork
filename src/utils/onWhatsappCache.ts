import { prismaRepository } from '@api/server.module';
import { configService, Database } from '@config/env.config';
import { Logger } from '@config/logger.config';
import { chooseLidValue, dedupePairs, getAvailableNumbers, isRealLidJid, LidPnPair } from '@utils/jidIdentity';
import dayjs from 'dayjs';

const logger = new Logger('OnWhatsappCache');

interface ISaveOnWhatsappCacheParams {
  remoteJid: string;
  remoteJidAlt?: string;
  lid?: 'lid' | undefined;
}

function normalizeJid(jid: string | null | undefined): string | null {
  if (!jid) return null;
  return jid.startsWith('+') ? jid.slice(1) : jid;
}

export async function saveOnWhatsappCache(data: ISaveOnWhatsappCacheParams[]) {
  if (!configService.get<Database>('DATABASE').SAVE_DATA.IS_ON_WHATSAPP) {
    return;
  }

  // Processa todos os itens em paralelo para melhor performance
  const processingPromises = data.map(async (item) => {
    try {
      const remoteJid = normalizeJid(item.remoteJid);
      if (!remoteJid) {
        logger.warn('[saveOnWhatsappCache] Item skipped, missing remoteJid.');
        return;
      }

      const altJidNormalized = normalizeJid(item.remoteJidAlt);
      const lidAltJid = altJidNormalized && altJidNormalized.includes('@lid') ? altJidNormalized : null;

      const baseJids = [remoteJid]; // Garante que o remoteJid esteja na lista inicial
      if (lidAltJid) {
        baseJids.push(lidAltJid);
      }

      const expandedJids = baseJids.flatMap((jid) => getAvailableNumbers(jid));

      // 1. Busca entrada por jidOptions e também remoteJid
      // Às vezes acontece do remoteJid atual NÃO ESTAR no jidOptions ainda, ocasionando o erro:
      // 'Unique constraint failed on the fields: (`remoteJid`)'
      // Isso acontece principalmente em grupos que possuem o número do criador no ID (ex.: '559911223345-1234567890@g.us')
      const existingRecord = await prismaRepository.isOnWhatsapp.findFirst({
        where: {
          OR: [
            ...expandedJids.map((jid) => ({ jidOptions: { contains: jid } })),
            { remoteJid: remoteJid }, // TODO: Descobrir o motivo que causa o remoteJid não estar (às vezes) incluso na lista de jidOptions
          ],
        },
      });

      logger.verbose(
        `[saveOnWhatsappCache] Register exists for [${expandedJids.join(',')}]? => ${existingRecord ? existingRecord.remoteJid : 'Not found'}`,
      );

      // 2. Unifica todos os JIDs usando um Set para garantir valores únicos
      const finalJidOptions = new Set(expandedJids);

      if (lidAltJid) {
        finalJidOptions.add(lidAltJid);
      }

      if (existingRecord?.jidOptions) {
        existingRecord.jidOptions.split(',').forEach((jid) => finalJidOptions.add(jid));
      }

      // 3. Prepara o payload final
      // Ordena os JIDs para garantir consistência na string final
      const sortedJidOptions = [...finalJidOptions].sort();
      const newJidOptionsString = sortedJidOptions.join(',');
      // A coluna passa a guardar o LID real quando ele vem na gravação, e um LID real já
      // aprendido nunca é trocado por flag ou null — antes, qualquer mensagem sem LID
      // apagava o valor e o par se perdia.
      const newLid = chooseLidValue({
        incoming: [remoteJid, altJidNormalized].find((jid) => isRealLidJid(jid)),
        existing: existingRecord?.lid,
        lidAddressed: item.lid === 'lid' || item.remoteJid?.includes('@lid'),
      });

      const dataPayload = {
        remoteJid: remoteJid,
        jidOptions: newJidOptionsString,
        lid: newLid,
      };

      // 4. Decide entre Criar ou Atualizar
      if (existingRecord) {
        // Compara a string de JIDs ordenada existente com a nova
        const existingJidOptionsString = existingRecord.jidOptions
          ? existingRecord.jidOptions.split(',').sort().join(',')
          : '';

        const isDataSame =
          existingRecord.remoteJid === dataPayload.remoteJid &&
          existingJidOptionsString === dataPayload.jidOptions &&
          existingRecord.lid === dataPayload.lid;

        if (isDataSame) {
          logger.verbose(`[saveOnWhatsappCache] Data for ${remoteJid} is already up-to-date. Skipping update.`);
          return; // Pula para o próximo item
        }

        // Os dados são diferentes, então atualiza
        logger.verbose(
          `[saveOnWhatsappCache] Register exists, updating: remoteJid=${remoteJid}, jidOptions=${dataPayload.jidOptions}, lid=${dataPayload.lid}`,
        );
        await prismaRepository.isOnWhatsapp.update({
          where: { id: existingRecord.id },
          data: dataPayload,
        });
      } else {
        // Cria nova entrada
        logger.verbose(
          `[saveOnWhatsappCache] Register does not exist, creating: remoteJid=${remoteJid}, jidOptions=${dataPayload.jidOptions}, lid=${dataPayload.lid}`,
        );
        await prismaRepository.isOnWhatsapp.create({
          data: dataPayload,
        });
      }
    } catch (e) {
      // Loga o erro mas não para a execução dos outros promises
      logger.error(`[saveOnWhatsappCache] Error processing item for ${item.remoteJid}: `);
      logger.error(e);
    }
  });

  // Espera todas as operações paralelas terminarem
  await Promise.allSettled(processingPromises);
}

export async function getOnWhatsappCache(remoteJids: string[]) {
  let results: {
    remoteJid: string;
    number: string;
    jidOptions: string[];
    lid?: string;
  }[] = [];

  if (configService.get<Database>('DATABASE').SAVE_DATA.IS_ON_WHATSAPP) {
    const remoteJidsWithoutPlus = remoteJids.map((remoteJid) => getAvailableNumbers(remoteJid)).flat();

    const onWhatsappCache = await prismaRepository.isOnWhatsapp.findMany({
      where: {
        OR: remoteJidsWithoutPlus.map((remoteJid) => ({ jidOptions: { contains: remoteJid } })),
        updatedAt: {
          gte: dayjs().subtract(configService.get<Database>('DATABASE').SAVE_DATA.IS_ON_WHATSAPP_DAYS, 'days').toDate(),
        },
      },
    });

    results = onWhatsappCache.map((item) => ({
      remoteJid: item.remoteJid,
      number: item.remoteJid.split('@')[0],
      jidOptions: item.jidOptions.split(','),
      lid: item.lid,
    }));
  }

  return results;
}

/**
 * Grava pares LID↔número na coluna IsOnWhatsapp.lid, na linha do número.
 *
 * É o espelho durável do armazenamento de mapeamentos do Baileys, que vive no estado de
 * autenticação e é apagado no logout. Os pares chegam do sync de histórico, das chaves
 * das mensagens e do evento lid-mapping.update. O par é um fato estável do usuário, então
 * aqui não há validade por data como no cache de "está no WhatsApp".
 *
 * A linha é localizada pelo número exato ou por uma das suas variações (9º dígito), com
 * comparação exata depois da busca: o `contains` sozinho casaria um número que é sufixo
 * de outro (ex.: 554497091885 dentro de 1554497091885).
 */
export async function saveLidPnMappings(pairs: LidPnPair[]): Promise<void> {
  if (!configService.get<Database>('DATABASE').SAVE_DATA.IS_ON_WHATSAPP) {
    return;
  }

  for (const { lid, pn } of dedupePairs(pairs)) {
    try {
      const variants = getAvailableNumbers(pn);

      const candidates = await prismaRepository.isOnWhatsapp.findMany({
        where: {
          OR: [{ remoteJid: pn }, ...variants.map((jid) => ({ jidOptions: { contains: jid } }))],
        },
      });

      const record = candidates.find(
        (row) => row.remoteJid === pn || row.jidOptions.split(',').some((jid) => variants.includes(jid)),
      );

      if (record) {
        if (record.lid !== lid) {
          await prismaRepository.isOnWhatsapp.update({ where: { id: record.id }, data: { lid } });
          logger.verbose(`[saveLidPnMappings] ${lid} -> ${record.remoteJid}`);
        }
        continue;
      }

      await prismaRepository.isOnWhatsapp.create({
        data: { remoteJid: pn, jidOptions: [...new Set(variants)].sort().join(','), lid },
      });
      logger.verbose(`[saveLidPnMappings] ${lid} -> ${pn} (novo)`);
    } catch (error) {
      // Perder um par aqui não é grave: ele volta na próxima mensagem ou sync desse contato.
      logger.warn(`[saveLidPnMappings] Falha ao gravar ${lid} -> ${pn}: ${error?.message ?? error}`);
    }
  }
}
