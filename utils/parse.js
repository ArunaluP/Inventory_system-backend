// Strict input parsing shared by the validators.
// JavaScript's Number() is too forgiving for user input: Number('0x10') = 16, Number(true) = 1,
// Number([5]) = 5, Number('1e3') = 1000. These helpers only accept real numbers or plain
// decimal text, so anything else is reported as invalid instead of silently converted.

const DECIMAL_TEXT = /^-?\d+(\.\d+)?$/;
const INTEGER_TEXT = /^\d+$/;

// Finite number from a number or plain decimal text ("12", "-3.5"); NaN otherwise
const parseDecimal = (value) => {
  if (typeof value === 'number') return Number.isFinite(value) ? value : NaN;
  if (typeof value === 'string' && DECIMAL_TEXT.test(value.trim())) return Number(value.trim());
  return NaN;
};

// Positive whole number (ids) from a number or digit text; null otherwise
const parseId = (value) => {
  if (typeof value === 'number') return Number.isInteger(value) && value > 0 ? value : null;
  if (typeof value === 'string' && INTEGER_TEXT.test(value.trim())) {
    const n = Number(value.trim());
    return n > 0 && Number.isSafeInteger(n) ? n : null;
  }
  return null;
};

// true / false from a boolean or 1 / 0 / "true" / "false" / "1" / "0"; undefined otherwise
const parseBoolean = (value) => {
  if (typeof value === 'boolean') return value;
  if (value === 1 || value === '1' || value === 'true') return true;
  if (value === 0 || value === '0' || value === 'false') return false;
  return undefined;
};

// Text from a string or number; null for objects / arrays (which would become "[object Object]")
const isTextLike = (value) => typeof value === 'string' || typeof value === 'number';

module.exports = { parseDecimal, parseId, parseBoolean, isTextLike };
