import { Controller, Get } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { ApiProblems, ApiSuccess, ApiSummary } from '../common/http/api-docs';
import { RATES_EXAMPLE } from '../docs/examples';
import { toRatesResource, type RatesResource } from './fx.mapper';
import { RateService } from './rate.service';

@ApiTags('fx')
@Controller('fx')
export class FxController {
  constructor(private readonly rates: RateService) {}

  @Get('rates')
  @ApiSummary(
    'Current rate matrix',
    'All 20 ordered pairs, as exact 12-decimal rates. The rates are simulated: see provider and source.',
  )
  @ApiSuccess(200, 'The current rates (abridged example)', RATES_EXAMPLE)
  @ApiProblems('FX_UNAVAILABLE')
  list(): RatesResource {
    return toRatesResource(this.rates.getRateMatrix());
  }
}
