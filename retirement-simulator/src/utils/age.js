import { CURRENT_YEAR } from '../model/assumptions.js';

// Matches the annual age convention used by the pension and projection models.
function birthYearForAge(age, year = CURRENT_YEAR) {
  return Number.isInteger(age) && age >= 0 ? year - age : null;
}

function birthYearLabel(age, year = CURRENT_YEAR) {
  const birthYear = birthYearForAge(age, year);
  return birthYear === null ? '' : `${birthYear}년생 · ${year}년 − 나이 (생일 미반영)`;
}

export { birthYearForAge, birthYearLabel };
