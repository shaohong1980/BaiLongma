import assert from 'node:assert/strict'

const media = await import('./capabilities/tools/media.js')

const expectedExports = [
  'autoSpeakForVoiceReply',
  'execGenerateImage',
  'execGenerateLyrics',
  'execGenerateMusic',
  'execGenerateVideo',
  'execMediaMode',
  'execMusic',
  'execSpeak',
  'getAIVideoPanelState',
  'getVideoHistory',
  'resumePendingVideoJobs',
  'saveGeneratedVideo',
  'setAIVideoPanelState',
  'stripMarkdownForSpeech',
]

assert.deepEqual(Object.keys(media).sort(), expectedExports.sort())
assert.equal(
  media.stripMarkdownForSpeech('**你好** [世界](https://example.com)'),
  '你好 世界',
)
assert.deepEqual(
  JSON.parse(media.execMediaMode({ mode: 'unsupported' })),
  {
    ok: false,
    tool: 'media_mode',
    error: 'mode must be video, camera, image, or music',
  },
)

console.log('media module boundary tests passed')
