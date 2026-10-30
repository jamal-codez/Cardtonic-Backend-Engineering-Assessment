import { Injectable, PipeTransform } from '@nestjs/common';
import { AppError } from '../errors/app-error';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Accepts a UUID of any version (including v7) and returns it lower-cased. */
@Injectable()
export class UuidParamPipe implements PipeTransform<string, string> {
  transform(value: string): string {
    if (typeof value !== 'string' || !UUID_PATTERN.test(value)) {
      throw new AppError('VALIDATION_ERROR', {
        detail: 'id must be a UUID',
        errors: [{ field: 'id', message: 'must be a UUID' }],
      });
    }
    return value.toLowerCase();
  }
}
