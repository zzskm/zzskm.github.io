export const SECTION_FIELDS = {
  '프로필': ['currentAge','retireAge','selfLifeExpectancy','selfPensionStartAge'],
  '가구': ['spouseEnabled','spouseCurrentAge','spouseRetireAge','spouseLifeExpectancy','children'],
  '소득': ['selfCurrentSalary','selfSalaryBasis','spouseCurrentSalary','spouseSalaryBasis','selfNpInputMode','selfNpManualMonthly','selfNpAutoMode','selfNpYears','spouseNpInputMode','spouseNpManualMonthly','spouseNpAutoMode','spouseNpYears','spousePensionStartAge','postRetireSideIncome','salaryGrowthRate'],
  '자산': ['savingsBalance','investmentBalance','monthlyAddSaving'],
  '주거': ['housingMode','housePrice','hasMortgage','mortgageBalance','monthlyMortgagePayment','mortgageRate','deposit','monthlyRent','housingMaintenance','housingInflationScenario'],
  '생활비 (현재가치)': ['workingLivingCost','bridgeLivingCost','retirementLivingCost','childCostMultiplier','medicalCostMultiplier'],
  '이벤트 — 다운사이징': ['downsizeEnabled','downsizeAge','downsizeRatio'],
  '시장 가정': ['investmentReturnRate','savingsReturnRate','inflationRate','scenarioBandSpread','returnVolatility','houseInflationRate','stressTest'],
  '세제·건보·의료': ['applyHealthInsurance','applyBasicPension','applyMedicalCost','includeSeveranceLumpSum'],
  '인출 전략': ['withdrawalStrategy'],
};
