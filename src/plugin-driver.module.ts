import { Module, Global } from '@nestjs/common';
import { PluginDriverService } from './plugin-driver.service';

@Global()
@Module({
  providers: [PluginDriverService],
  exports: [PluginDriverService],
})
export class PluginDriverModule {}
