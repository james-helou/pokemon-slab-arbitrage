export type LogLevel = 'info' | 'warn' | 'error';
export type Log = (level: LogLevel, msg: string, data?: Record<string, unknown>) => void;

export const log: Log = (level, msg, data) => {
  console.log(JSON.stringify({ t: new Date().toISOString(), level, msg, ...data }));
};

export const silentLog: Log = () => {};
