const HOURLY_STUDENT_PLATFORM_FEE_RATE = 0.12;
const HOURLY_EMPLOYER_PLATFORM_FEE_RATE = 0.12;

function money(value) {
  return Number((Number(value || 0) || 0).toFixed(2));
}

function calculateHourlyProjectFees(workTotal = 0) {
  const base = money(workTotal);
  const studentPlatformFee = money(base * HOURLY_STUDENT_PLATFORM_FEE_RATE);
  const employerPlatformFee = money(base * HOURLY_EMPLOYER_PLATFORM_FEE_RATE);
  return {
    workTotal: base,
    studentPlatformFee,
    employerPlatformFee,
    platformFeeTotal: money(studentPlatformFee + employerPlatformFee),
    studentPayout: money(base - studentPlatformFee),
    employerTotal: money(base + employerPlatformFee),
  };
}

module.exports = {
  HOURLY_STUDENT_PLATFORM_FEE_RATE,
  HOURLY_EMPLOYER_PLATFORM_FEE_RATE,
  calculateHourlyProjectFees,
};
