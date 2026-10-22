// Browser Settings copy complements the captured desktop translation catalog.
// Column order is Spanish, French, German, Portuguese, Simplified Chinese,
// Japanese and Korean. Machine preference values and language autonyms stay fixed.
type Values = readonly [string, string, string, string, string, string, string];
export const appearanceTranslations: Readonly<Record<string, Values>> = Object.freeze({
  'Current language: %s': ['Idioma actual: %s', 'Langue actuelle : %s', 'Aktuelle Sprache: %s', 'Idioma atual: %s', '当前语言：%s', '現在の言語: %s', '현재 언어: %s'],
  'Language choices': ['Opciones de idioma', 'Choix de langue', 'Sprachauswahl', 'Opções de idioma', '语言选项', '言語の選択肢', '언어 선택'],
  'Uses your browser display language. English is used when no supported language matches.': [
    'Usa el idioma de visualización del navegador. Se usa inglés si no hay ningún idioma compatible.',
    'Utilise la langue d’affichage du navigateur. L’anglais est utilisé si aucune langue prise en charge ne correspond.',
    'Verwendet die Anzeigesprache Ihres Browsers. Wenn keine unterstützte Sprache passt, wird Englisch verwendet.',
    'Usa o idioma de exibição do navegador. O inglês é usado quando nenhum idioma compatível corresponde.',
    '使用浏览器的显示语言。没有匹配的受支持语言时使用英语。',
    'ブラウザーの表示言語を使用します。対応する言語がない場合は英語を使用します。',
    '브라우저 표시 언어를 사용합니다. 일치하는 지원 언어가 없으면 영어를 사용합니다.',
  ],
  'Could not save language. Your previous language is unchanged. Try again when local storage is available.': [
    'No se pudo guardar el idioma. El idioma anterior no ha cambiado. Inténtalo de nuevo cuando el almacenamiento local esté disponible.',
    'Impossible d’enregistrer la langue. La langue précédente est conservée. Réessayez lorsque le stockage local sera disponible.',
    'Die Sprache konnte nicht gespeichert werden. Die vorherige Sprache bleibt erhalten. Versuchen Sie es erneut, wenn der lokale Speicher verfügbar ist.',
    'Não foi possível salvar o idioma. O idioma anterior permanece inalterado. Tente novamente quando o armazenamento local estiver disponível.',
    '无法保存语言。之前的语言保持不变。请在本地存储可用时重试。',
    '言語を保存できませんでした。以前の言語は変更されていません。ローカルストレージが利用可能になったら、もう一度お試しください。',
    '언어를 저장하지 못했습니다. 이전 언어는 변경되지 않았습니다. 로컬 저장소를 사용할 수 있을 때 다시 시도하세요.',
  ],
  'Current theme: %s': ['Tema actual: %s', 'Thème actuel : %s', 'Aktuelles Design: %s', 'Tema atual: %s', '当前主题：%s', '現在のテーマ: %s', '현재 테마: %s'],
  'Theme choices': ['Opciones de tema', 'Choix du thème', 'Designauswahl', 'Opções de tema', '主题选项', 'テーマの選択肢', '테마 선택'],
  'Could not save theme. Your previous theme is unchanged. Try again when local storage is available.': [
    'No se pudo guardar el tema. El tema anterior no ha cambiado. Inténtalo de nuevo cuando el almacenamiento local esté disponible.',
    'Impossible d’enregistrer le thème. Le thème précédent est conservé. Réessayez lorsque le stockage local sera disponible.',
    'Das Design konnte nicht gespeichert werden. Das vorherige Design bleibt erhalten. Versuchen Sie es erneut, wenn der lokale Speicher verfügbar ist.',
    'Não foi possível salvar o tema. O tema anterior permanece inalterado. Tente novamente quando o armazenamento local estiver disponível.',
    '无法保存主题。之前的主题保持不变。请在本地存储可用时重试。',
    'テーマを保存できませんでした。以前のテーマは変更されていません。ローカルストレージが利用可能になったら、もう一度お試しください。',
    '테마를 저장하지 못했습니다. 이전 테마는 변경되지 않았습니다. 로컬 저장소를 사용할 수 있을 때 다시 시도하세요.',
  ],
  'Current size: %s': ['Tamaño actual: %s', 'Taille actuelle : %s', 'Aktuelle Größe: %s', 'Tamanho atual: %s', '当前字号：%s', '現在のサイズ: %s', '현재 크기: %s'],
  'Font size choices': ['Opciones de tamaño de fuente', 'Choix de la taille du texte', 'Schriftgrößenauswahl', 'Opções de tamanho da fonte', '字号选项', '文字サイズの選択肢', '글꼴 크기 선택'],
  'Could not save font size. Your previous size is unchanged. Try again when local storage is available.': [
    'No se pudo guardar el tamaño de fuente. El tamaño anterior no ha cambiado. Inténtalo de nuevo cuando el almacenamiento local esté disponible.',
    'Impossible d’enregistrer la taille du texte. La taille précédente est conservée. Réessayez lorsque le stockage local sera disponible.',
    'Die Schriftgröße konnte nicht gespeichert werden. Die vorherige Größe bleibt erhalten. Versuchen Sie es erneut, wenn der lokale Speicher verfügbar ist.',
    'Não foi possível salvar o tamanho da fonte. O tamanho anterior permanece inalterado. Tente novamente quando o armazenamento local estiver disponível.',
    '无法保存字号。之前的字号保持不变。请在本地存储可用时重试。',
    '文字サイズを保存できませんでした。以前のサイズは変更されていません。ローカルストレージが利用可能になったら、もう一度お試しください。',
    '글꼴 크기를 저장하지 못했습니다. 이전 크기는 변경되지 않았습니다. 로컬 저장소를 사용할 수 있을 때 다시 시도하세요.',
  ],
  'Close Settings': ['Cerrar Configuración', 'Fermer les paramètres', 'Einstellungen schließen', 'Fechar Configurações', '关闭设置', '設定を閉じる', '설정 닫기'],
  'Close settings (Esc)': ['Cerrar configuración (Esc)', 'Fermer les paramètres (Esc)', 'Einstellungen schließen (Esc)', 'Fechar configurações (Esc)', '关闭设置 (Esc)', '設定を閉じる (Esc)', '설정 닫기 (Esc)'],
  'Settings sections': ['Secciones de Configuración', 'Sections des paramètres', 'Einstellungsbereiche', 'Seções das Configurações', '设置类别', '設定項目', '설정 섹션'],
});
export const appearanceAliases: Readonly<Record<string, string>> = Object.freeze({});
