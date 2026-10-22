import type { BrowserTranslations } from '../i18n';

// Authored browser status and canvas guidance. These are not additions to the
// captured native catalogs. Order: es, fr, de, pt, zh-Hans, ja, ko.
export const accessibilityTranslations: BrowserTranslations = Object.freeze({
  'Scene status': ['Estado de la escena', 'État de la scène', 'Szenenstatus', 'Estado da cena', '场景状态', 'シーンの状態', '장면 상태'],
  'Tab moves between the scene and controls. Scene shortcuts work while the scene has focus. Open Tutorial for navigation and selection controls. The canvas is visual; scene status reports the current file, tool and selection counts.': [
    'Tab mueve el foco entre la escena y los controles. Los atajos de la escena funcionan cuando esta tiene el foco. Abre el Tutorial para consultar los controles de navegación y selección. El lienzo es visual; el estado de la escena indica el archivo actual, la herramienta y los recuentos de selección.',
    'Tab déplace le focus entre la scène et les commandes. Les raccourcis de la scène fonctionnent lorsqu’elle a le focus. Ouvrez le Tutoriel pour les commandes de navigation et de sélection. Le canevas est visuel ; l’état de la scène indique le fichier actuel, l’outil et les nombres de sélection.',
    'Tab wechselt zwischen Szene und Bedienelementen. Szenenkürzel funktionieren, wenn die Szene den Fokus hat. Öffnen Sie das Tutorial für Navigations- und Auswahlsteuerung. Die Zeichenfläche ist visuell; der Szenenstatus nennt die aktuelle Datei, das Werkzeug und die Auswahlanzahl.',
    'Tab alterna o foco entre a cena e os controles. Os atalhos da cena funcionam quando ela está em foco. Abra o Tutorial para os controles de navegação e seleção. A tela é visual; o estado da cena informa o arquivo atual, a ferramenta e as contagens de seleção.',
    '按 Tab 在场景与控件之间移动焦点。场景获得焦点时可使用场景快捷键。打开教程了解导航和选择控件。画布以视觉方式呈现；场景状态会报告当前文件、工具和选择数量。',
    'Tab キーでシーンとコントロール間のフォーカスを移動します。シーンにフォーカスがある間はシーンのショートカットが使えます。ナビゲーションと選択の操作はチュートリアルで確認できます。キャンバスは視覚的な表示で、シーンの状態には現在のファイル、ツール、選択数が示されます。',
    'Tab 키로 장면과 컨트롤 사이의 포커스를 이동합니다. 장면에 포커스가 있으면 장면 단축키를 사용할 수 있습니다. 탐색 및 선택 컨트롤은 튜토리얼에서 확인하세요. 캔버스는 시각적 표시이며 장면 상태는 현재 파일, 도구 및 선택 개수를 알려 줍니다.',
  ],
  'Restoring graphics.': ['Restaurando los gráficos.', 'Restauration du rendu graphique.', 'Grafik wird wiederhergestellt.', 'Restaurando os gráficos.', '正在恢复图形。', 'グラフィックスを復元しています。', '그래픽을 복원하는 중입니다.'],
  'Starting viewer.': ['Iniciando el visor.', 'Démarrage de la visionneuse.', 'Ansicht wird gestartet.', 'Iniciando o visualizador.', '正在启动查看器。', 'ビューアーを起動しています。', '뷰어를 시작하는 중입니다.'],
  'Opening a scene.': ['Abriendo una escena.', 'Ouverture d’une scène.', 'Eine Szene wird geöffnet.', 'Abrindo uma cena.', '正在打开场景。', 'シーンを開いています。', '장면을 여는 중입니다.'],
  'Closing the scene.': ['Cerrando la escena.', 'Fermeture de la scène.', 'Szene wird geschlossen.', 'Fechando a cena.', '正在关闭场景。', 'シーンを閉じています。', '장면을 닫는 중입니다.'],
  'Restoring selection.': ['Restaurando la selección.', 'Restauration de la sélection.', 'Auswahl wird wiederhergestellt.', 'Restaurando a seleção.', '正在恢复选择。', '選択を復元しています。', '선택을 복원하는 중입니다.'],
  'Scene work in progress.': ['Hay una operación de escena en curso.', 'Une opération sur la scène est en cours.', 'Szenenverarbeitung läuft.', 'Uma operação na cena está em andamento.', '正在处理场景操作。', 'シーンの処理が進行中です。', '장면 작업이 진행 중입니다.'],
  'Viewer is not ready.': ['El visor no está listo.', 'La visionneuse n’est pas prête.', 'Ansicht ist noch nicht bereit.', 'O visualizador não está pronto.', '查看器尚未就绪。', 'ビューアーはまだ準備できていません。', '뷰어가 아직 준비되지 않았습니다.'],
  'Orbit navigation': ['Navegación orbital', 'Navigation orbitale', 'Orbit-Navigation', 'Navegação orbital', '环绕导航', '周回ナビゲーション', '궤도 탐색'],
  'Look navigation': ['Navegación de vista libre', 'Navigation en vue libre', 'Freie Blicknavigation', 'Navegação de olhar livre', '视角导航', '視点ナビゲーション', '시점 탐색'],
  'Alignment: center': ['Alineación: centro', 'Alignement : centre', 'Ausrichtung: Mittelpunkt', 'Alinhamento: centro', '对齐：中心', '位置合わせ：中心', '정렬: 중심'],
  'Alignment: scale': ['Alineación: escala', 'Alignement : échelle', 'Ausrichtung: Maßstab', 'Alinhamento: escala', '对齐：缩放', '位置合わせ：スケール', '정렬: 배율'],
  'Alignment: points': ['Alineación: puntos', 'Alignement : points', 'Ausrichtung: Punkte', 'Alinhamento: pontos', '对齐：点', '位置合わせ：点', '정렬: 점'],
  'Alignment: floor': ['Alineación: suelo', 'Alignement : sol', 'Ausrichtung: Boden', 'Alinhamento: piso', '对齐：地面', '位置合わせ：床面', '정렬: 바닥'],
  'Current scene': ['Escena actual', 'Scène actuelle', 'Aktuelle Szene', 'Cena atual', '当前场景', '現在のシーン', '현재 장면'],
  'No scene open. %s mode. %s.': [
    'No hay ninguna escena abierta. Modo %s. %s.',
    'Aucune scène ouverte. Mode %s. %s.',
    'Keine Szene geöffnet. Modus %s. %s.',
    'Nenhuma cena aberta. Modo %s. %s.',
    '未打开场景。%s 模式。%s。',
    'シーンは開かれていません。%s モード。%s。',
    '열린 장면이 없습니다. %s 모드. %s.',
  ],
  'Ready. %s. %u selected of %u visible. %s mode. %s.': [
    'Listo. %s. %u seleccionados de %u visibles. Modo %s. %s.',
    'Prêt. %s. %u sélectionnés sur %u visibles. Mode %s. %s.',
    'Bereit. %s. %u ausgewählt von %u sichtbar. Modus %s. %s.',
    'Pronto. %s. %u selecionados de %u visíveis. Modo %s. %s.',
    '就绪。%s。已选择 %u 个，可见 %u 个。%s 模式。%s。',
    '準備完了。%s。選択数 %u、表示数 %u。%s モード。%s。',
    '준비됨. %s. 선택 %u개, 표시 %u개. %s 모드. %s.',
  ],
  '%s Combine: %s.': ['%s Combinación: %s.', '%s Combinaison : %s.', '%s Verknüpfung: %s.', '%s Combinação: %s.', '%s 组合方式：%s。', '%s 組み合わせ：%s。', '%s 결합: %s.'],
});
