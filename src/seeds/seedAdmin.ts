/* eslint-disable @typescript-eslint/no-unsafe-assignment */
/* eslint-disable @typescript-eslint/no-floating-promises */
import db from '../utils/db';
import * as bcrypt from 'bcrypt';

async function hashPassword(password: string): Promise<string> {
  try {
    const saltRounds: number = Number(process.env.SALTROUNDS) || 10;
    const hashedPassword = await bcrypt.hash(password, saltRounds);
    return hashedPassword;
  } catch (error) {
    if (error instanceof Error) {
      console.error('Error hashing password:', error.message);
    } else {
      console.error('Unknown error hashing password:', error);
    }
    throw error;
  }
}

async function seedAdmin(): Promise<void> {
  try {
    const hashedPassword = await hashPassword('admin');
    const adminUser = await db.user.create({
      data: {
        email: 'admin@admin.com',
        name: 'admin',
        password: hashedPassword,
        phone: '01111837474',
      },
    });

    console.log('Admin user created:', adminUser);
  } catch (error) {
    console.error(
      'Error creating admin user:',
      error instanceof Error ? error.message : error,
    );
  }
}

// Proper async invocation
(async () => {
  try {
    await seedAdmin();
  } catch (error) {
    console.error(
      'Error during seeding process:',
      error instanceof Error ? error.message : error,
    );
  }
})();
