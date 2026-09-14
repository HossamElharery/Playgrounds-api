import { GUARDS_METADATA } from '@nestjs/common/constants';
import { IS_PUBLIC_KEY } from '../../common/decorators/public.decorator';
import { AuthGuard } from '../../common/guards/auth.guard';
import type { AuthenticatedUser } from '../../common/types/authenticated-user.interface';
import { BookingsController } from './bookings.controller';
import { BookingsService } from './bookings.service';

describe('BookingsController access policy', () => {
  it('requires authentication and binds split-share payments to the current user', async () => {
    const bookings = {
      paySplitShare: jest.fn().mockResolvedValue({ status: 'paid' }),
    };
    const controller = new BookingsController(
      bookings as unknown as BookingsService,
    );
    const handler = Object.getOwnPropertyDescriptor(
      BookingsController.prototype,
      'paySplitShare',
    )?.value as object | undefined;

    if (!handler) throw new Error('paySplitShare handler is missing');
    expect(Reflect.getMetadata(IS_PUBLIC_KEY, handler)).not.toBe(true);
    expect(Reflect.getMetadata(GUARDS_METADATA, handler)).toContain(AuthGuard);

    const user = { id: 'user-1' } as AuthenticatedUser;
    await expect(
      controller.paySplitShare(user, 'share-token'),
    ).resolves.toEqual({ status: 'paid' });
    expect(bookings.paySplitShare).toHaveBeenCalledWith(
      'share-token',
      'user-1',
    );
  });
});
