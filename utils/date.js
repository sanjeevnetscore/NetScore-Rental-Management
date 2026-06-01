function calculateRemainingDays(planEndDate) {
  const end = new Date(planEndDate);
  const today = new Date();

  const diffTime = end - today;
  return Math.max(0, Math.ceil(diffTime / (1000 * 60 * 60 * 24)));
}

module.exports = { calculateRemainingDays };
