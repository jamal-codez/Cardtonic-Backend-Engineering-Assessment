import { Global, Module } from '@nestjs/common';
import { RANDOM, type Random } from './runtime';

@Global()
@Module({
  providers: [{ provide: RANDOM, useFactory: (): Random => () => Math.random() }],
  exports: [RANDOM],
})
export class RuntimeModule {}
