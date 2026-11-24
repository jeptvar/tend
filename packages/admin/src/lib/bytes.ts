import type { IntlShape } from "react-intl";

const BYTE_UNITS = ["byte", "kilobyte", "megabyte", "gigabyte", "terabyte"] as const;

/** A size the way phones and computers show it, in the admin's language: 2.4 GB. */
export function bytesText(intl: IntlShape, bytes: number): string {
  let value = bytes;
  let unit = 0;
  while (value >= 1000 && unit < BYTE_UNITS.length - 1) {
    value /= 1000;
    unit++;
  }
  return intl.formatNumber(value, {
    style: "unit",
    unit: BYTE_UNITS[unit],
    unitDisplay: "short",
    maximumFractionDigits: unit > 0 && value < 10 ? 1 : 0,
  });
}
