import { Body, Controller, Get, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { AuthGuard } from '../../common/guards/auth.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../../common/types/authenticated-user.interface';
import { WalletService } from './wallet.service';
import { TopUpWalletDto } from './dto/top-up-wallet.dto';
import { WithdrawWalletDto } from './dto/withdraw-wallet.dto';
import { ResolveWithdrawalDto } from './dto/resolve-withdrawal.dto';

@ApiTags('wallet')
@ApiBearerAuth()
@UseGuards(AuthGuard)
@Controller()
export class WalletController {
  constructor(private readonly wallet: WalletService) {}

  @Get('wallet')
  get(@CurrentUser() user: AuthenticatedUser) {
    return this.wallet.get(user.id);
  }

  @Post('wallet/top-up')
  topUp(@CurrentUser() user: AuthenticatedUser, @Body() dto: TopUpWalletDto) {
    return this.wallet.topUp(user.id, dto.amount, dto.method);
  }

  @Post('wallet/withdraw')
  withdraw(@CurrentUser() user: AuthenticatedUser, @Body() dto: WithdrawWalletDto) {
    return this.wallet.requestWithdrawal(user.id, dto.amount, dto.destination);
  }

  @Roles('admin')
  @Get('admin/wallet/withdrawals')
  listWithdrawals(@Query('status') status?: 'pending' | 'paid' | 'rejected') {
    return this.wallet.listWithdrawals(status);
  }

  @Roles('admin')
  @Patch('admin/wallet/withdrawals/:id')
  resolveWithdrawal(
    @CurrentUser() admin: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: ResolveWithdrawalDto,
  ) {
    return this.wallet.resolveWithdrawal(admin.id, id, dto.status, dto.note);
  }
}
