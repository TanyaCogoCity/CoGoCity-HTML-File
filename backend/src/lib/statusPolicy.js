const config = require('../config');

const allowedTransitions = {
  accepted: ['funded', 'in_progress', 'canceled'],
  funded: ['in_progress', 'canceled'],
  in_progress: ['awaiting_approval', 'canceled'],
  awaiting_approval: ['completed', 'in_progress', 'canceled'],
  completed: [],
  canceled: [],
};

function canTransition(fromStatus, toStatus) {
  if (!config.strictStatusTransitions) return true;
  if (!fromStatus || fromStatus === toStatus) return true;
  const allowed = allowedTransitions[fromStatus] || [];
  return allowed.includes(toStatus);
}

module.exports = { canTransition };
