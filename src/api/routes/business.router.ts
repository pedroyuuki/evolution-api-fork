import { RouterBroker } from '@api/abstract/abstract.router';
import { UploadMediaDto } from '@api/dto/business.dto';
import { NumberDto } from '@api/dto/chat.dto';
import { businessController } from '@api/server.module';
import { createMetaErrorResponse } from '@utils/errorResponse';
import { catalogSchema, collectionsSchema } from '@validate/validate.schema';
import { RequestHandler, Router } from 'express';
import multer from 'multer';

import { HttpStatus } from './index.router';

// Teto do maior tipo aceito pela Meta (documento, 100 MB); os limites por tipo vêm depois.
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 100 * 1024 * 1024, files: 1 } });
// Erro do multer (ex.: arquivo acima do teto) vira 400 com o motivo, não 500.
const uploadFile: RequestHandler = (req, res, next) =>
  upload.single('file')(req, res, (error) =>
    error ? res.status(HttpStatus.BAD_REQUEST).json(createMetaErrorResponse(error, 'business_upload_media')) : next(),
  );

export class BusinessRouter extends RouterBroker {
  constructor(...guards: RequestHandler[]) {
    super();
    this.router
      .post(this.routerPath('getCatalog'), ...guards, async (req, res) => {
        try {
          const response = await this.dataValidate<NumberDto>({
            request: req,
            schema: catalogSchema,
            ClassRef: NumberDto,
            execute: (instance, data) => businessController.fetchCatalog(instance, data),
          });

          return res.status(HttpStatus.OK).json(response);
        } catch (error) {
          // Log error for debugging
          console.error('Business catalog error:', error);

          // Use utility function to create standardized error response
          const errorResponse = createMetaErrorResponse(error, 'business_catalog');
          return res.status(errorResponse.status).json(errorResponse);
        }
      })

      .post(this.routerPath('getCollections'), ...guards, async (req, res) => {
        try {
          const response = await this.dataValidate<NumberDto>({
            request: req,
            schema: collectionsSchema,
            ClassRef: NumberDto,
            execute: (instance, data) => businessController.fetchCollections(instance, data),
          });

          return res.status(HttpStatus.OK).json(response);
        } catch (error) {
          // Log error for debugging
          console.error('Business collections error:', error);

          // Use utility function to create standardized error response
          const errorResponse = createMetaErrorResponse(error, 'business_collections');
          return res.status(errorResponse.status).json(errorResponse);
        }
      })

      .post(this.routerPath('uploadMedia'), ...guards, uploadFile, async (req, res) => {
        try {
          const response = await this.dataValidate<UploadMediaDto>({
            request: req,
            schema: null,
            ClassRef: UploadMediaDto,
            execute: (instance, data) => businessController.uploadMedia(instance, data, req.file),
          });

          return res.status(HttpStatus.CREATED).json(response);
        } catch (error) {
          const errorResponse = createMetaErrorResponse(error, 'business_upload_media');
          return res.status(errorResponse.status).json(errorResponse);
        }
      });
  }

  public readonly router: Router = Router();
}
