export function createDisplayModeAccessService() {
  const reject = () => { const error = new Error("展示模式不在公开范围"); error.status = 404; throw error; };
  return {
    verify: reject,
    status: () => ({ available: false, enrolled: false }),
    beginRegistration: reject,
    finishRegistration: reject,
    beginAuthentication: reject,
    finishAuthentication: reject,
  };
}
