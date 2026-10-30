import { Body, Controller, Get, Param, Post, Res } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { UuidParamPipe } from '../common/http/uuid-param.pipe';
import { CreateWalletDto } from './dto/create-wallet.dto';
import type { WalletResource } from './wallet.mapper';
import { WalletsService } from './wallets.service';

@ApiTags('wallets')
@Controller('wallets')
export class WalletsController {
  constructor(private readonly wallets: WalletsService) {}

  @Post()
  async create(
    @Body() dto: CreateWalletDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<WalletResource> {
    const wallet = await this.wallets.create({ email: dto.email, phone: dto.phone });
    res.setHeader('Location', `/v1/wallets/${wallet.id}`);
    return wallet;
  }

  @Get(':id')
  get(@Param('id', UuidParamPipe) id: string): Promise<WalletResource> {
    return this.wallets.get(id);
  }
}
