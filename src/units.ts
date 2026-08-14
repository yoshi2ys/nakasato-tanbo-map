/** 1 畝 = 30 坪。1 坪 = 400/121 ㎡。 */
const SQUARE_METERS_PER_SE = 30 * (400 / 121);
/** 1 反 = 10 畝。 */
const SQUARE_METERS_PER_TAN = SQUARE_METERS_PER_SE * 10;

export interface FormattedArea {
  squareMeters: string;
  tan: string;
  se: string;
}

function format(value: number, digits: number): string {
  return value.toLocaleString('ja-JP', {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
}

export function formatArea(squareMeters: number): FormattedArea {
  return {
    // 100 ㎡ を超えたら小数は情報にならないので整数で示す。
    squareMeters: format(squareMeters, squareMeters < 100 ? 1 : 0),
    tan: format(squareMeters / SQUARE_METERS_PER_TAN, 2),
    se: format(squareMeters / SQUARE_METERS_PER_SE, 1),
  };
}
