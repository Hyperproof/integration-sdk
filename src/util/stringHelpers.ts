/**
 * Removes the trailing character from a string if it exists
 *
 * @param str The string to remove the trailing character from
 * @param char The character to remove from the end of the string
 * @returns The string with the trailing character removed
 */
export const removeTrailing = (str: string, char: string) => {
  if (char.length > 1 || char.length === 0) {
    throw new Error('char must be a single character');
  }
  if (str.endsWith(char)) {
    return str.slice(0, -1);
  }
  return str;
};

/**
 * Removes the leading character from a string if it exists
 *
 * @param str The string to remove the leading character from
 * @param char The character to remove from the beginning of the string
 * @returns The string with the leading character removed
 */
export const removeLeading = (str: string, char: string) => {
  if (char.length > 1 || char.length === 0) {
    throw new Error('char must be a single character');
  }
  if (str.startsWith(char)) {
    return str.slice(1);
  }
  return str;
};

/**
 * Removes the surrounding character from a string if it exists
 * @param str The string to remove the surrounding character from
 * @param char The character to remove from the beginning and end of the string
 * @returns The string with the surrounding character removed
 */
export const removeSurrounding = (str: string, char: string) => {
  return removeTrailing(removeLeading(str, char), char);
};

export const removeSurroundingQuotes = (str: string) => {
  return removeSurrounding(str, '"');
};
