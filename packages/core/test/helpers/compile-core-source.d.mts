export type CoreSourceMutation = { name: string; file: string; before: string; after: string };
export type CandidateCoreBuild = {
  candidate: string; out: string; core: string; cli: string;
  inputs: Record<string,string>; loaded: Record<string,string>; emitted: Record<string,string>;
  mutations: string[]; boundary: string;
};
/** Private test package graph, including the actual Core child workers; never a release build or typecheck. */
export function buildCandidateCore(candidate:string,out:string,options?:{mutations?:CoreSourceMutation[]}):Promise<CandidateCoreBuild>;
