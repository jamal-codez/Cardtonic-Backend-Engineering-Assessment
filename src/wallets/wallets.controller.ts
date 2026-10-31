import { Body, Controller, Get, Param, Post, Res } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { ApiProblems, ApiSuccess, ApiSummary } from '../common/http/api-docs';
import { UuidParamPipe } from '../common/http/uuid-param.pipe';
import { WALLET_EXAMPLE } from '../docs/examples';
import { CreateWalletDto } from './dto/create-wallet.dto';
import type { WalletResource } from './wallet.mapper';
import { WalletsService } from './wallets.service';

@ApiTags('wallets')
@Controller('wallets')
export class WalletsController {
  constructor(private readonly wallets: WalletsService) {}

  @Post()
  @ApiSummary(
    'Create a wallet',
    'Needs an email, a phone number or both. Creates one zero-balance account per supported coin. Email and phone are unique (email case-insensitively).',
  )
  @ApiSuccess(201, 'Wallet created (Location header points at it)', WALLET_EXAMPLE)
  @ApiProblems('VALIDATION_ERROR', 'WALLET_ALREADY_EXISTS')
  async create(
    @Body() dto: CreateWalletDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<WalletResource> {
    const wallet = await this.wallets.create({ email: dto.email, phone: dto.phone });
    res.setHeader('Location', `/v1/wallets/${wallet.id}`);
    return wallet;
  }

  @Get(':id')
  @ApiSummary(
    'Get a wallet',
    'Balances per coin plus an indicative USD total from the current rates.',
  )
  @ApiSuccess(200, 'The wallet', WALLET_EXAMPLE)
  @ApiProblems('VALIDATION_ERROR', 'WALLET_NOT_FOUND')
  get(@Param('id', UuidParamPipe) id: string): Promise<WalletResource> {
    return this.wallets.get(id);
  }
}
