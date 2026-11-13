/** These unrelated painters must never be entered by the book-only native fixture. */
export const SourceFilePreview=()=>{throw new Error('Unexpected source painter in book reader proof')}
export const EditorPane=SourceFilePreview
export const NoteFileSurfaceView=SourceFilePreview
export const FileSourceEditor=SourceFilePreview

export const PdfReader=SourceFilePreview
export const MediaPlayer=SourceFilePreview
export const preparePdfReader=SourceFilePreview
