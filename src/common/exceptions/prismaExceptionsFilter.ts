/* eslint-disable @typescript-eslint/no-unsafe-member-access */

export default function handlePrismaErrors(exception: any) {
  switch (exception.code) {
    // Prisma Client Errors (Query Engine)
    case 'P2000':
      return { statusCode: 400, message: 'Value too long for field type' };
    case 'P2001':
      return { statusCode: 404, message: 'Record not found' };
    case 'P2002':
      return {
        statusCode: 409,
        message: 'Unique constraint failed: ' + exception.meta?.target,
      };
    case 'P2003':
      return {
        statusCode: 400,
        message: 'Foreign key constraint failed: ' + exception.meta?.field_name,
      };
    case 'P2004':
      return { statusCode: 400, message: 'Database constraint violation' };
    case 'P2005':
      return {
        statusCode: 400,
        message: 'Invalid field value: ' + exception.meta?.field_name,
      };
    case 'P2006':
      return {
        statusCode: 400,
        message:
          'Invalid value format for field: ' + exception.meta?.field_name,
      };
    case 'P2007':
      return {
        statusCode: 400,
        message: 'Data validation error: ' + exception.meta?.details,
      };
    case 'P2008':
      return { statusCode: 400, message: 'Query parsing failed' };
    case 'P2009':
      return { statusCode: 400, message: 'Query validation failed' };
    case 'P2010':
      return {
        statusCode: 400,
        message: 'Raw query failed: ' + exception.meta?.details,
      };
    case 'P2011':
      return { statusCode: 400, message: 'Null constraint violation' };
    case 'P2012':
      return { statusCode: 400, message: 'Missing required value' };
    case 'P2013':
      return { statusCode: 400, message: 'Missing required argument' };
    case 'P2014':
      return {
        statusCode: 409,
        message: 'Relation violation: ' + exception.meta?.details,
      };
    case 'P2015':
      return { statusCode: 404, message: 'Related record not found' };
    case 'P2016':
      return { statusCode: 400, message: 'Query interpretation error' };
    case 'P2017':
      return { statusCode: 404, message: 'Related records not connected' };
    case 'P2018':
      return { statusCode: 408, message: 'Request timeout' };
    case 'P2019':
      return { statusCode: 400, message: 'Invalid null value' };
    case 'P2020':
      return { statusCode: 400, message: 'Value out of range' };
    case 'P2021':
      return { statusCode: 500, message: 'Database table does not exist' };
    case 'P2022':
      return { statusCode: 500, message: 'Database column does not exist' };
    case 'P2023':
      return { statusCode: 500, message: 'Inconsistent column data' };
    case 'P2024':
      return { statusCode: 408, message: 'Transaction timeout' };
    case 'P2025':
      return {
        statusCode: 404,
        message: 'Record required for operation not found',
      };
    case 'P2026':
      return { statusCode: 500, message: 'Database provider not compatible' };
    case 'P2027':
      return { statusCode: 500, message: 'Multiple database errors occurred' };

    // Prisma Migrate Errors
    case 'P3000':
      return { statusCode: 500, message: 'Database migration failed' };
    case 'P3001':
      return { statusCode: 400, message: 'Migration rollback failed' };
    case 'P3002':
      return { statusCode: 400, message: 'Migration name too long' };
    case 'P3003':
      return { statusCode: 400, message: 'Invalid migration format' };
    case 'P3004':
      return { statusCode: 500, message: 'System database changed' };
    case 'P3005':
      return { statusCode: 400, message: 'Database schema not empty' };
    case 'P3006':
      return { statusCode: 400, message: 'Migration already applied' };
    case 'P3007':
      return { statusCode: 400, message: 'Pending migrations detected' };
    case 'P3008':
      return { statusCode: 400, message: 'Invalid migration history' };
    case 'P3009':
      return { statusCode: 400, message: 'Failed to apply migration' };
    case 'P3010':
      return { statusCode: 400, message: 'Migration name in use' };
    case 'P3011':
      return { statusCode: 400, message: 'Migration cannot be rolled back' };
    case 'P3012':
      return { statusCode: 400, message: 'Migration not found' };
    case 'P3013':
      return { statusCode: 400, message: 'Datasource provider mismatch' };
    case 'P3014':
      return { statusCode: 500, message: 'Shadow database creation failed' };
    case 'P3015':
      return { statusCode: 400, message: 'Migration file not found' };
    case 'P3016':
      return { statusCode: 400, message: 'Failed to reset database' };
    case 'P3017':
      return { statusCode: 404, message: 'Migration failed to apply' };
    case 'P3018':
      return { statusCode: 400, message: 'Migration apply timeout' };
    case 'P3019':
      return { statusCode: 400, message: 'Database provider mismatch' };

    // Data Proxy Errors
    case 'P4000':
      return { statusCode: 500, message: 'Data proxy URL invalid' };
    case 'P4001':
      return { statusCode: 401, message: 'Data proxy unauthorized' };
    case 'P4002':
      return { statusCode: 504, message: 'Data proxy timeout' };

    // Transaction Errors
    case 'P2033':
      return { statusCode: 409, message: 'Transaction deadlock' };
    case 'P2034':
      return { statusCode: 408, message: 'Transaction timeout' };
    case 'P2040':
      return { statusCode: 429, message: 'Transaction retries exhausted' };
    case 'P2041':
      return { statusCode: 429, message: 'Transaction retry limit exceeded' };

    default:
      return {
        statusCode: 500,
        message: `Unhandled Prisma error (${exception.code}): ${exception.message}`,
      };
  }
}
