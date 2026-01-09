import http from 'http';
import https from 'https';

const httpAgentDefaults = {
  keepAlive: true,
  maxSockets: 1000, // per host
  maxTotalSockets: 5000, // total sockets across all hosts
  maxFreeSockets: 10,
  timeout: 60 * 1000 // 1 minute timeout for inactive sockets
};
const httpsAgentDefaults = {
  ...httpAgentDefaults
};

const httpAgent: http.Agent = new http.Agent(httpAgentDefaults);
const httpsAgent: https.Agent = new https.Agent(httpsAgentDefaults);

export const getAgent = (uri: string): http.Agent | https.Agent => {
  if (!uri) {
    throw new Error('No URI provided to getAgent.');
  }
  return new URL(uri).protocol === 'https:' ? httpsAgent : httpAgent;
};

/**
 * Creates fetch options with agent conditionally included only if it exists.
 * This avoids passing undefined agent property to fetch.
 *
 * @param uri - The URI for which to get the agent
 * @param baseOptions - Base fetch options to extend
 * @returns Fetch options with agent conditionally included
 */
export const createFetchOptions = (
  uri: string,
  baseOptions: RequestInit = {}
): any => {
  const agent = getAgent(uri);
  const options = { ...baseOptions } as any;

  options.agent = agent;

  return options;
};
