import { LocalDate, ZonedDateTime, ZoneId } from '@js-joda/core';

/**
 * Utility class for working with Dates.
 */
export class Dates {
  /**
   * Returns a ZonedDateTime given a LocalDate.
   *
   * @param d The LocalDate to convert.
   */
  public static zonedDateTimeFromLocalDate(d: LocalDate): ZonedDateTime {
    // A LocalDate does not have a time component (HH:mm:ss), so we set it to the start of the day.
    return d.atStartOfDay(ZoneId.SYSTEM);
  }

  /**
   * Converts a local date to a ZonedDateTime using 12 noon for the time component.
   * This provides a convenient and reliable way to store local dates.
   *
   * @param d The LocalDate to convert.
   */
  public static zonedDateTimeFromLocalDateAtNoon(d: LocalDate): ZonedDateTime {
    return Dates.zonedDateTimeFromLocalDate(d).plusHours(12);
  }

  /**
   * Converts a local date to an ISO 8601 string.
   *
   * @param d The LocalDate to convert.
   */
  public static iso8601DateTimeFromLocalDateAtNoon(d: LocalDate): string {
    return Dates.zonedDateTimeFromLocalDateAtNoon(d).toInstant().toString();
  }
}
