import { preparePrivateCertificates } from './private-certificates.js'

const [host, directory, ...extra] = process.argv.slice(2)
if (!host || !directory || extra.length) {
  console.error('Usage: prepare-private-access <private-ip> <private-certificate-directory>')
  process.exitCode = 1
} else {
  try {
    const material = await preparePrivateCertificates(directory, host)
    process.stdout.write(JSON.stringify({ ...material, host,
      nextStep: 'Install root.cer on the iPhone, then enable full SSL trust in system settings. Verify the public issuer fingerprint before approving this Host. Network access and device approval remain unconfirmed.' }) + '\n')
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'Private certificate preparation failed.')
    process.exitCode = 1
  }
}
