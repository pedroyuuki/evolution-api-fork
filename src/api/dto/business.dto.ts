/** Upload de mídia para a Meta: arquivo (multipart `file`) ou `url` para a Evolution baixar. */
export class UploadMediaDto {
  url?: string;
}

export class NumberDto {
  number: string;
}

export class getCatalogDto {
  number?: string;
  limit?: number;
  cursor?: string;
}

export class getCollectionsDto {
  number?: string;
  limit?: number;
}
