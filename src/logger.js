export function logStructured({ level, event, message, ...details }) {
  const payload = {
    t: new Date().toISOString(),
    level,
    event,
    message,
    ...details,
  };
  console.log(JSON.stringify(payload));
}
