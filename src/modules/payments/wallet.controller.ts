import { Body, Controller, Get, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { AuthGuard } from '../../common/guards/auth.guard';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../../common/types/authenticated-user.interface';
import { WalletService } from './wallet.service';
import { TopUpWalletDto } from './dto/top-up-wallet.dto';

@ApiTags('wallet')
@ApiBearerAuth()
@UseGuards(AuthGuard)
@Controller('wallet')
export class WalletController {
  constructor(private readonly wallet: WalletService) {}

  @Get()
  get(@CurrentUser() user: AuthenticatedUser) {
    return this.wallet.get(user.id);
  }

  @Post('top-up')
  topUp(@CurrentUser() user: AuthenticatedUser, @Body() dto: TopUpWalletDto) {
    return this.wallet.topUp(user.id, dto.amount, dto.method);
  }
}
