import { getCatalogDto, getCollectionsDto, UploadMediaDto } from '@api/dto/business.dto';
import { InstanceDto } from '@api/dto/instance.dto';
import { WAMonitoringService } from '@api/services/monitor.service';
import { Integration } from '@api/types/wa.types';

export class BusinessController {
  constructor(private readonly waMonitor: WAMonitoringService) {}

  public async fetchCatalog({ instanceName }: InstanceDto, data: getCatalogDto) {
    return await this.waMonitor.waInstances[instanceName].fetchCatalog(instanceName, data);
  }

  public async fetchCollections({ instanceName }: InstanceDto, data: getCollectionsDto) {
    return await this.waMonitor.waInstances[instanceName].fetchCollections(instanceName, data);
  }

  public async uploadMedia(
    { instanceName }: InstanceDto,
    data: UploadMediaDto,
    file?: { buffer: Buffer; originalname?: string },
  ) {
    const instance = this.waMonitor.waInstances[instanceName];
    if (instance?.integration !== Integration.WHATSAPP_BUSINESS) {
      throw new Error('uploadMedia é só para instâncias WHATSAPP-BUSINESS (Cloud API)');
    }
    return await instance.uploadMediaToMeta(data, file);
  }
}
