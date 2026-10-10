import { Body, Controller, Get, Param, Patch, Post, Put, Query, UseGuards, UseInterceptors } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { AuthGuard } from '../../../common/guards/auth.guard';
import { Roles } from '../../../common/decorators/roles.decorator';
import { RequirePermission } from '../../../common/decorators/permissions.decorator';
import { CurrentUser } from '../../../common/decorators/current-user.decorator';
import { AdminEditAuditInterceptor } from '../../../common/interceptors/admin-edit-audit.interceptor';
import { AuthenticatedUser } from '../../../common/types/authenticated-user.interface';
import { GamingSessionsService } from './gaming-sessions.service';
import { GamingCommerceService } from './gaming-commerce.service';
import { GamingReceiptsService } from './gaming-receipts.service';
import { ChangePlayModeDto, UnitTariffDto, BookingReceiptDto, BillingSettingsDto, CorrectSessionEndDto, CreateGamingUnitsDto, DuplicateGamingUnitsDto, GamingMaintenanceDto, CollectOrderDto, CreateOrderDto, DiscountOrderDto, ExtendSessionDto, GamingCapabilitiesDto, GamingCommandDto, GamingQueryDto, GamingVersionDto, PrintJobDto, PrintStatusDto, ProductDto, ProductLineDto, QuantityDto, ReasonCommandDto, ReceiptSettingsDto, RefundOrderDto, ReturnLineDto, StartSessionDto, StockDto, TransferSessionDto } from './gaming-operations.dto';
@ApiTags('owner-gaming') @ApiBearerAuth() @UseGuards(AuthGuard) @UseInterceptors(AdminEditAuditInterceptor) @Roles('owner','staff','admin')
@Controller('owner/gaming')
export class GamingOperationsController {
 constructor(private readonly sessions:GamingSessionsService,private readonly commerce:GamingCommerceService,private readonly receipts:GamingReceiptsService) {}
 @Get('capabilities') @RequirePermission('bookings.view') capabilities(@CurrentUser() u:AuthenticatedUser,@Query() q:GamingQueryDto){return this.sessions.capabilities(u,q.venueId);}
 @Put('capabilities') @RequirePermission('venue.manage') configure(@CurrentUser() u:AuthenticatedUser,@Body() d:GamingCapabilitiesDto){return this.sessions.configure(u,d);}
 @Put('billing-policy') @RequirePermission('pricing.manage') billing(@CurrentUser() u:AuthenticatedUser,@Body() d:BillingSettingsDto){return this.sessions.billing(u,d);}
 @Post('units') @RequirePermission('venue.manage') units(@CurrentUser() u:AuthenticatedUser,@Body() d:CreateGamingUnitsDto){return this.sessions.createUnits(u,d);}
 @Post('units/duplicate') @RequirePermission('venue.manage') duplicateUnits(@CurrentUser() u:AuthenticatedUser,@Body() d:DuplicateGamingUnitsDto){return this.sessions.duplicateUnits(u,d);}
 @Post('maintenance') @RequirePermission('schedule.manage') maintenance(@CurrentUser() u:AuthenticatedUser,@Body() d:GamingMaintenanceDto){return this.sessions.maintenance(u,d);}
 @Post('maintenance/:id/reopen') @RequirePermission('schedule.manage') reopen(@CurrentUser() u:AuthenticatedUser,@Param('id') id:string,@Body() d:GamingCommandDto){return this.sessions.reopen(u,id,d);}
 @Get('board') @RequirePermission('bookings.view') board(@CurrentUser() u:AuthenticatedUser,@Query() q:GamingQueryDto){return this.sessions.board(u,q.venueId,q.at);}
 @Put('units/tariffs') @RequirePermission('pricing.manage') tariffs(@CurrentUser() u:AuthenticatedUser,@Body() d:UnitTariffDto){return this.sessions.tariffs(u,d);}
 @Post('sessions/:id/play-mode') @RequirePermission('sessions.transfer') playMode(@CurrentUser() u:AuthenticatedUser,@Param('id') id:string,@Body() d:ChangePlayModeDto){return this.sessions.changePlayMode(u,id,d);}
 @Post('sessions/start') @RequirePermission('sessions.start') start(@CurrentUser() u:AuthenticatedUser,@Body() d:StartSessionDto){return this.sessions.start(u,d);}
 @Post('sessions/:id/end') @RequirePermission('sessions.end') end(@CurrentUser() u:AuthenticatedUser,@Param('id') id:string,@Body() d:GamingVersionDto){return this.sessions.end(u,id,d);}
 @Post('sessions/:id/extend') @RequirePermission('sessions.transfer') extend(@CurrentUser() u:AuthenticatedUser,@Param('id') id:string,@Body() d:ExtendSessionDto){return this.sessions.extend(u,id,d);}
 @Post('sessions/:id/transfer') @RequirePermission('sessions.transfer') transfer(@CurrentUser() u:AuthenticatedUser,@Param('id') id:string,@Body() d:TransferSessionDto){return this.sessions.transfer(u,id,d);}
 @Post('sessions/:id/correct-end') @RequirePermission('sessions.correct') correctEnd(@CurrentUser() u:AuthenticatedUser,@Param('id') id:string,@Body() d:CorrectSessionEndDto){return this.sessions.correctEnd(u,id,d);}
 @Post('sessions/:id/void') @RequirePermission('sessions.correct') void(@CurrentUser() u:AuthenticatedUser,@Param('id') id:string,@Body() d:ReasonCommandDto){return this.sessions.void(u,id,d);}
 @Get('products') @RequirePermission('products.view') products(@CurrentUser() u:AuthenticatedUser,@Query() q:GamingQueryDto){return this.commerce.products(u,q.venueId,q.cursor);}
 @Post('products') @RequirePermission('products.manage') product(@CurrentUser() u:AuthenticatedUser,@Body() d:ProductDto){return this.commerce.product(u,d);}
 @Patch('products/:id') @RequirePermission('products.manage') updateProduct(@CurrentUser() u:AuthenticatedUser,@Param('id') id:string,@Body() d:ProductDto){return this.commerce.product(u,d,id);}
 @Post('products/:id/stock') @RequirePermission('products.manage') stock(@CurrentUser() u:AuthenticatedUser,@Param('id') id:string,@Body() d:StockDto){return this.commerce.stock(u,id,d);}
 @Get('orders') @RequirePermission('orders.manage') orders(@CurrentUser() u:AuthenticatedUser,@Query() q:GamingQueryDto){return this.commerce.list(u,q.venueId,q.cursor,q.state);}
 @Post('orders') @RequirePermission('orders.manage') createOrder(@CurrentUser() u:AuthenticatedUser,@Body() d:CreateOrderDto){return this.commerce.create(u,d);}
 @Get('orders/:id') @RequirePermission('orders.manage') detail(@CurrentUser() u:AuthenticatedUser,@Param('id') id:string){return this.commerce.detail(u,id);}
 @Post('orders/:id/lines') @RequirePermission('orders.manage') line(@CurrentUser() u:AuthenticatedUser,@Param('id') id:string,@Body() d:ProductLineDto){return this.commerce.add(u,id,d);}
 @Patch('orders/:id/lines/:lineId') @RequirePermission('orders.manage') quantity(@CurrentUser() u:AuthenticatedUser,@Param('id') id:string,@Param('lineId') l:string,@Body() d:QuantityDto){return this.commerce.quantity(u,id,l,d);}
 @Post('orders/:id/lines/:lineId/return') @RequirePermission('refunds.issue') returns(@CurrentUser() u:AuthenticatedUser,@Param('id') id:string,@Param('lineId') l:string,@Body() d:ReturnLineDto){return this.commerce.returnLine(u,id,l,d);}
 @Post('orders/:id/discount') @RequirePermission('discounts.apply') discount(@CurrentUser() u:AuthenticatedUser,@Param('id') id:string,@Body() d:DiscountOrderDto){return this.commerce.discount(u,id,d);}
 @Post('orders/:id/payments') @RequirePermission('payments.record') collect(@CurrentUser() u:AuthenticatedUser,@Param('id') id:string,@Body() d:CollectOrderDto){return this.commerce.collect(u,id,d);}
 @Post('orders/:id/refund') @RequirePermission('refunds.issue') refund(@CurrentUser() u:AuthenticatedUser,@Param('id') id:string,@Body() d:RefundOrderDto){return this.commerce.refund(u,id,d);}
 @Post('orders/:id/settle') @RequirePermission('orders.manage') settle(@CurrentUser() u:AuthenticatedUser,@Param('id') id:string,@Body() d:GamingVersionDto){return this.commerce.settle(u,id,d);}
 @Post('orders/:id/bill') @RequirePermission('receipts.print') bill(@CurrentUser() u:AuthenticatedUser,@Param('id') id:string,@Body() d:GamingCommandDto){return this.receipts.bill(u,id,d);}
 @Post('bookings/:id/receipt') @RequirePermission('receipts.print') bookingReceipt(@CurrentUser() u:AuthenticatedUser,@Param('id') id:string,@Body() d:BookingReceiptDto){return this.receipts.booking(u,id,d);}
 @Get('receipt-settings') @RequirePermission('receipts.print') settings(@CurrentUser() u:AuthenticatedUser,@Query() q:GamingQueryDto){return this.receipts.settings(u,q.venueId);}
 @Put('receipt-settings') @RequirePermission('printer.manage') saveSettings(@CurrentUser() u:AuthenticatedUser,@Body() d:ReceiptSettingsDto){return this.receipts.configure(u,d);}
 @Get('receipts/:id') @RequirePermission('receipts.print') receipt(@CurrentUser() u:AuthenticatedUser,@Param('id') id:string){return this.receipts.read(u,id);}
 @Post('receipts/:id/print-jobs') @RequirePermission('receipts.print') job(@CurrentUser() u:AuthenticatedUser,@Param('id') id:string,@Body() d:PrintJobDto){return this.receipts.job(u,id,d);}
 @Post('print-jobs/:id/status') @RequirePermission('receipts.print') status(@CurrentUser() u:AuthenticatedUser,@Param('id') id:string,@Body() d:PrintStatusDto){return this.receipts.status(u,id,d);}
}
