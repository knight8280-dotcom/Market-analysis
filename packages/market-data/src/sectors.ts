/**
 * Sector and industry from SEC Standard Industrial Classification (SIC) codes.
 *
 * GICS is licensed by MSCI and S&P and cannot be used without a license, so sectors here are
 * our own grouping of public SIC codes into eleven broad groups. It is documented and
 * deterministic, but it is not GICS. Notable differences: Alphabet and Meta land in Technology
 * (SIC 7370), and big-box retailers in Consumer Discretionary.
 */

export const SECTORS = [
  "Technology",
  "Health Care",
  "Financials",
  "Real Estate",
  "Energy",
  "Materials",
  "Industrials",
  "Utilities",
  "Communication Services",
  "Consumer Staples",
  "Consumer Discretionary",
] as const;
export type Sector = (typeof SECTORS)[number];

type Rule = [from: number, to: number, sector: Sector];

// First match wins, so specific ranges come before the broad ones they sit inside.
const RULES: readonly Rule[] = [
  // Technology: computers, electronics and semiconductors, instruments, software and services.
  [3570, 3579, "Technology"],
  [3600, 3629, "Industrials"],
  [3630, 3639, "Consumer Discretionary"],
  [3640, 3659, "Industrials"],
  [3660, 3699, "Technology"],
  [3820, 3829, "Technology"],
  [7370, 7379, "Technology"],
  // Health care: pharma and biotech, medical devices, health services.
  [2830, 2836, "Health Care"],
  [3840, 3851, "Health Care"],
  [5120, 5122, "Health Care"],
  [8000, 8099, "Health Care"],
  [8731, 8734, "Health Care"],
  // Energy: oil and gas extraction, refining, pipelines, coal.
  [1200, 1399, "Energy"],
  [2900, 2999, "Energy"],
  [4610, 4619, "Energy"],
  [4922, 4925, "Energy"],
  // Utilities: electric, gas, water, sanitary services.
  [4900, 4999, "Utilities"],
  // Communication services: telecom, broadcasting, publishing, motion pictures.
  [4800, 4899, "Communication Services"],
  [2700, 2799, "Communication Services"],
  [7810, 7849, "Communication Services"],
  // Real estate: operators, developers and REITs.
  [6500, 6553, "Real Estate"],
  [6798, 6798, "Real Estate"],
  // Financials: banks, credit, brokers, insurance, holding and investment offices.
  [6000, 6799, "Financials"],
  // Consumer staples: food, beverages, tobacco, household products, food and drug retail.
  [2000, 2199, "Consumer Staples"],
  [2840, 2844, "Consumer Staples"],
  [5140, 5149, "Consumer Staples"],
  [5400, 5499, "Consumer Staples"],
  [5910, 5912, "Consumer Staples"],
  // Consumer discretionary: autos, apparel, furniture, retail, restaurants, hotels, leisure.
  [3710, 3716, "Consumer Discretionary"],
  [2300, 2399, "Consumer Discretionary"],
  [2500, 2599, "Consumer Discretionary"],
  [3100, 3199, "Consumer Discretionary"],
  [3940, 3949, "Consumer Discretionary"],
  [5200, 5999, "Consumer Discretionary"],
  [7000, 7099, "Consumer Discretionary"],
  [7900, 7999, "Consumer Discretionary"],
  // Materials: mining, chemicals, paper, metals, glass and stone, lumber.
  [1000, 1099, "Materials"],
  [1400, 1499, "Materials"],
  [2400, 2499, "Materials"],
  [2600, 2699, "Materials"],
  [2800, 2899, "Materials"],
  [3200, 3399, "Materials"],
  // Industrials: construction, machinery, aerospace, transport, business services.
  [1500, 1799, "Industrials"],
  [3400, 3599, "Industrials"],
  [3700, 3799, "Industrials"],
  [3800, 3899, "Industrials"],
  [4000, 4799, "Industrials"],
  [5000, 5199, "Industrials"],
  [7300, 7399, "Industrials"],
  [8700, 8799, "Industrials"],
  // Agriculture and remaining services.
  [100, 999, "Consumer Staples"],
];

/** Broad sector for a SIC code, or null when the code is missing or unmapped. */
export function sectorForSic(sic: string | number | null | undefined): Sector | null {
  if (sic === null || sic === undefined || sic === "") return null;
  const code = Number(sic);
  if (!Number.isInteger(code)) return null;
  for (const [from, to, sector] of RULES) {
    if (code >= from && code <= to) return sector;
  }
  return null;
}
