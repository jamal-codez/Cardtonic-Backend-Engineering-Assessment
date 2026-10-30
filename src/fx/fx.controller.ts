import { Controller, Get } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { toRatesResource, type RatesResource } from './fx.mapper';
import { RateService } from './rate.service';

@ApiTags('fx')
@Controller('fx')
export class FxController {
  constructor(private readonly rates: RateService) {}

  @Get('rates')
  list(): RatesResource {
    return toRatesResource(this.rates.getRateMatrix());
  }
}
