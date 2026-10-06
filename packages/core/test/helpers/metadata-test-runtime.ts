import { pathToFileURL } from 'node:url'
import * as core from '../../src/index.js'
import * as service from '../../src/hosted-runtime-service.js'
import * as wire from '../../src/hosted-value.js'
import { AgentMuxControlServer } from '../../src/public-rpc-server.js'

/** A whole compiled Core copy keeps class/error/artifact identity consistent in loaded mutants. */
export const metadataTestRuntime = process.env.AGENTMUX_TEST_METADATA_PACKAGE
  ? await (async () => {
    const root = process.env.AGENTMUX_TEST_METADATA_PACKAGE!
    const read = (file: string) => import(/* @vite-ignore */ pathToFileURL(`${root}/dist/${file}.js`).href)
    const [selected, selectedService, selectedWire, selectedServer] = await Promise.all([read('index'), read('hosted-runtime-service'), read('hosted-value'), read('public-rpc-server')])
    if (process.env.AGENTMUX_TEST_METADATA_MUTANT) {
      const mutation = await read(process.env.AGENTMUX_TEST_METADATA_MUTANT_MODULE!)
      if (mutation.AGENTMUX_METADATA_COUNTERFACTUAL !== process.env.AGENTMUX_TEST_METADATA_MUTANT) throw new Error('The selected Core did not load its exact compiled counterfactual.')
    }
    return { ...selected, ...selectedService, ...selectedWire, ...selectedServer } as typeof core & typeof service & typeof wire & { AgentMuxControlServer: typeof AgentMuxControlServer }
  })()
  : { ...core, ...service, ...wire, AgentMuxControlServer }
