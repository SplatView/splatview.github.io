import type { BrowserTranslations } from '../i18n';

// Browser adaptations and exact current-desktop v7 translation supplements.
// The generated historical native catalog remains unchanged; source ownership
// and current row provenance are recorded below. Order: es, fr, de, pt, zh-Hans, ja, ko.
export const tutorialTranslations: BrowserTranslations = Object.freeze({
  'Remember view': ['Recordar vista', 'Mémoriser la vue', 'Ansicht merken', 'Lembrar vista', '记住视图', 'ビューを記憶', '보기 기억'],
  'In Settings > General, choose Remember view to save this camera view and background in this browser.': ['En Ajustes > General, elige Recordar vista para guardar esta vista de cámara y el fondo en este navegador.', 'Dans Paramètres > Général, choisissez Mémoriser la vue pour enregistrer cette vue de caméra et son arrière-plan dans ce navigateur.', 'Unter Einstellungen > Allgemein die Option Ansicht merken wählen, um diese Kameraansicht und den Hintergrund in diesem Browser zu speichern.', 'Em Configurações > Geral, escolha Lembrar vista para salvar esta vista da câmera e o fundo neste navegador.', '在“设置”>“常规”中选择“记住视图”，将此相机视图和背景保存在当前浏览器中。', '設定 > 一般で「ビューを記憶」を選ぶと、このブラウザーにカメラビューと背景を保存できます。', '설정 > 일반에서 보기 기억을 선택하여 이 브라우저에 카메라 뷰와 배경을 저장합니다.'],
  'Adjust field of view or use Fullscreen. Page Up/Down browses an available scene collection when the scene has focus.': [
    'Ajusta el campo de visión o usa Pantalla completa. Re Pág y Av Pág recorren una colección de escenas disponible cuando la escena tiene el foco.',
    'Réglez le champ de vision ou passez en plein écran. Page précédente/suivante parcourt une collection de scènes disponible lorsque la scène a le focus.',
    'Passen Sie das Sichtfeld an oder nutzen Sie den Vollbildmodus. Bild auf/ab blättert durch eine verfügbare Szenensammlung, wenn die Szene den Fokus hat.',
    'Ajuste o campo de visão ou use Tela cheia. Page Up/Down percorre uma coleção de cenas disponível quando a cena está em foco.',
    '调整视野或使用全屏模式。场景获得焦点时，可用 Page Up/Down 浏览可用的场景集合。',
    '視野角を調整するか、全画面表示にします。シーンにフォーカスがあるとき、Page Up/Down で利用可能なシーンコレクションを移動できます。',
    '시야각을 조정하거나 전체 화면을 사용합니다. 장면에 포커스가 있으면 Page Up/Down으로 사용 가능한 장면 모음을 탐색합니다.',
  ],
  'Pick matching colors (Ctrl+E, or Command+E on Mac). Connected colors stays in one region. Tolerance updates live.': [
    'Selecciona colores similares (Ctrl+E, o Command+E en Mac). Colores conectados se limita a una región. La tolerancia se actualiza en directo.',
    'Sélectionnez les couleurs similaires (Ctrl+E, ou Command+E sur Mac). Couleurs connectées reste dans une seule région. La tolérance est actualisée en direct.',
    'Wählen Sie ähnliche Farben aus (Strg+E, auf dem Mac Command+E). Verbundene Farben bleibt auf einen Bereich beschränkt. Die Toleranz wird live aktualisiert.',
    'Selecione cores semelhantes (Ctrl+E, ou Command+E no Mac). Cores conectadas permanece em uma só região. A tolerância é atualizada ao vivo.',
    '选取相近的颜色（Ctrl+E，Mac 上为 Command+E）。“连通颜色”仅限于一个区域。容差会实时更新。',
    '似た色を選択します（Ctrl+E、Mac では Command+E）。接続された色の選択は一つの領域内に限定されます。許容値はリアルタイムで更新されます。',
    '비슷한 색상을 선택합니다(Ctrl+E, Mac에서는 Command+E). 연결된 색상은 한 영역으로 제한됩니다. 허용 오차는 실시간으로 업데이트됩니다.',
  ],
  'Click a connected region. G selects Fill when the scene has focus. Lower tolerance keeps the selection tighter.': [
    'Haz clic en una región conectada. G activa Rellenar cuando la escena tiene el foco. Una tolerancia menor limita más la selección.',
    'Cliquez sur une région connectée. G sélectionne Remplissage lorsque la scène a le focus. Une tolérance plus faible restreint la sélection.',
    'Klicken Sie auf einen verbundenen Bereich. G wählt Füllen, wenn die Szene den Fokus hat. Eine geringere Toleranz grenzt die Auswahl stärker ein.',
    'Clique em uma região conectada. G seleciona Preencher quando a cena está em foco. Uma tolerância menor restringe mais a seleção.',
    '点击一个连通区域。场景获得焦点时，按 G 选择“填充”。降低容差可使选择范围更精确。',
    'つながった領域をクリックします。シーンにフォーカスがあるとき、G で塗りつぶしを選択します。許容値を下げると選択範囲が狭まります。',
    '연결된 영역을 클릭합니다. 장면에 포커스가 있으면 G로 채우기를 선택합니다. 허용 오차를 낮추면 선택 범위가 더 좁아집니다.',
  ],
  '1-4: Replace, Add, Subtract, Intersect. Shift adds; Ctrl (Command on Mac) subtracts; both intersect.': [
    '1-4: Reemplazar, Añadir, Restar, Intersecar. Shift añade; Ctrl (Command en Mac) resta; ambas teclas intersecan.',
    '1-4 : Remplacer, Ajouter, Soustraire, Intersection. Maj ajoute ; Ctrl (Command sur Mac) soustrait ; les deux donnent l’intersection.',
    '1-4: Ersetzen, Hinzufügen, Abziehen, Schnittmenge. Umschalt fügt hinzu; Strg (Command auf dem Mac) zieht ab; beide bilden die Schnittmenge.',
    '1-4: Substituir, Adicionar, Subtrair, Interseção. Shift adiciona; Ctrl (Command no Mac) subtrai; ambas as teclas fazem a interseção.',
    '1-4：替换、添加、减去、交集。Shift 添加；Ctrl（Mac 上为 Command）减去；同时按下两者取交集。',
    '1～4：置換、追加、削除、共通部分。Shift で追加、Ctrl（Mac では Command）で削除、両方で共通部分を選択します。',
    '1-4: 바꾸기, 추가, 빼기, 교집합. Shift는 추가, Ctrl(Mac에서는 Command)은 빼기, 둘 다 누르면 교집합을 선택합니다.',
  ],
  'Choose an automatic correction from Auto color. The Color controls show the result.': [
    'Elige una corrección automática en Color automático. Los controles de Color muestran el resultado.',
    'Choisissez une correction automatique dans Couleur auto. Les réglages de couleur affichent le résultat.',
    'Wählen Sie unter Automatische Farbe eine automatische Korrektur. Die Farbregler zeigen das Ergebnis.',
    'Escolha uma correção automática em Cor automática. Os controles de Cor mostram o resultado.',
    '从“自动颜色”中选择自动校正。“颜色”控件会显示结果。',
    '自動カラーから自動補正を選択します。カラーのコントロールに結果が反映されます。',
    '자동 색상에서 자동 보정을 선택합니다. 색상 컨트롤에 결과가 표시됩니다.',
  ],
  'Choose a preset to update the color preview. Use Apply color to commit the preview. Pro offers more presets.': [
    'Elige un ajuste preestablecido para actualizar la vista previa del color. Usa Aplicar color para confirmar la vista previa. Pro ofrece más ajustes.',
    'Choisissez un préréglage pour actualiser l’aperçu des couleurs. Utilisez Appliquer la couleur pour le valider. Pro propose davantage de préréglages.',
    'Wählen Sie eine Vorgabe, um die Farbvorschau zu aktualisieren. Übernehmen Sie sie mit Farbe anwenden. Pro bietet weitere Vorgaben.',
    'Escolha uma predefinição para atualizar a prévia de cor. Use Aplicar cor para confirmar a prévia. Pro oferece mais predefinições.',
    '选择预设以更新颜色预览。使用“应用颜色”提交预览。Pro 提供更多预设。',
    'プリセットを選択してカラーのプレビューを更新します。色を適用でプレビューを確定します。Pro ではさらに多くのプリセットを利用できます。',
    '프리셋을 선택하여 색상 미리보기를 업데이트합니다. 색상 적용으로 미리보기를 확정합니다. Pro에서는 더 많은 프리셋을 제공합니다.',
  ],
  'Reset the current color and opacity preview.': [
    'Restablece la vista previa actual de color y opacidad.',
    'Réinitialisez l’aperçu actuel des couleurs et de l’opacité.',
    'Setzen Sie die aktuelle Farb- und Deckkraftvorschau zurück.',
    'Redefina a prévia atual de cor e opacidade.',
    '重置当前的颜色和不透明度预览。',
    '現在のカラーと不透明度のプレビューをリセットします。',
    '현재 색상 및 불투명도 미리보기를 초기화합니다.',
  ],
  'Choose a format and export scope, then save a copy to keep the source.': [
    'Elige un formato y el alcance de exportación; después guarda una copia para conservar el archivo de origen.',
    'Choisissez un format et la portée de l’exportation, puis enregistrez une copie pour conserver la source.',
    'Wählen Sie Format und Exportumfang und speichern Sie eine Kopie, um die Quelldatei zu behalten.',
    'Escolha um formato e o escopo de exportação; depois salve uma cópia para preservar o arquivo de origem.',
    '选择格式和导出范围，然后保存副本以保留源文件。',
    '形式と書き出す範囲を選び、コピーを保存して元のファイルを残します。',
    '형식과 내보낼 범위를 선택한 다음 복사본을 저장하여 원본을 보존합니다.',
  ],
  'Capture saves an image. Copy sends it to the clipboard (Ctrl+C, or Command+C on Mac).': [
    'Capturar guarda una imagen. Copiar la envía al portapapeles (Ctrl+C, o Command+C en Mac).',
    'Capturer enregistre une image. Copier l’envoie dans le presse-papiers (Ctrl+C, ou Command+C sur Mac).',
    'Aufnehmen speichert ein Bild. Kopieren legt es in die Zwischenablage (Strg+C, auf dem Mac Command+C).',
    'Capturar salva uma imagem. Copiar envia a imagem para a área de transferência (Ctrl+C, ou Command+C no Mac).',
    '“捕获”保存图像。“复制”将图像发送到剪贴板（Ctrl+C，Mac 上为 Command+C）。',
    'キャプチャは画像を保存します。コピーは画像をクリップボードに送ります（Ctrl+C、Mac では Command+C）。',
    '캡처는 이미지를 저장합니다. 복사는 이미지를 클립보드로 보냅니다(Ctrl+C, Mac에서는 Command+C).',
  ],
  'Ctrl+Z: undo. Ctrl+Y: redo. On Mac, use Command instead of Ctrl.': [
    'Ctrl+Z: deshacer. Ctrl+Y: rehacer. En Mac, usa Command en lugar de Ctrl.',
    'Ctrl+Z : annuler. Ctrl+Y : rétablir. Sur Mac, utilisez Command au lieu de Ctrl.',
    'Strg+Z: rückgängig. Strg+Y: wiederholen. Auf dem Mac verwenden Sie Command statt Strg.',
    'Ctrl+Z: desfazer. Ctrl+Y: refazer. No Mac, use Command no lugar de Ctrl.',
    'Ctrl+Z：撤销。Ctrl+Y：重做。在 Mac 上使用 Command 代替 Ctrl。',
    'Ctrl+Z：元に戻す。Ctrl+Y：やり直す。Mac では Ctrl の代わりに Command を使います。',
    'Ctrl+Z: 실행 취소. Ctrl+Y: 다시 실행. Mac에서는 Ctrl 대신 Command를 사용합니다.',
  ],
  'Enable Range for Color or Fill. A successful pick fixes its center; the sphere is shown in Tools. Release Radius or finish typing to update the same selection.': [
    'Activa Rango para Color o Rellenar. Una selección correcta fija su centro; la esfera se muestra en Herramientas. Suelta Radio o termina de escribir para actualizar la misma selección.',
    'Activez Portée pour Couleur ou Remplissage. Un clic réussi fixe le centre ; la sphère apparaît dans Outils. Relâchez Rayon ou terminez la saisie pour actualiser la même sélection.',
    'Aktivieren Sie den Bereich für Farbe oder Füllen. Ein erfolgreicher Klick fixiert den Mittelpunkt; die Kugel erscheint unter Werkzeuge. Lassen Sie Radius los oder beenden Sie die Eingabe, um dieselbe Auswahl zu aktualisieren.',
    'Ative Alcance para Cor ou Preencher. Um clique bem-sucedido fixa o centro; a esfera aparece em Ferramentas. Solte Raio ou conclua a digitação para atualizar a mesma seleção.',
    '为颜色或填充启用“范围”。成功选取后中心即固定，球体显示在“工具”中。松开“半径”滑块或完成输入，即可更新同一次选择。',
    'カラーまたは塗りつぶしで範囲を有効にします。選択に成功すると中心が固定され、ツールに球が表示されます。半径のスライダーを離すか入力を終えると、同じ選択が更新されます。',
    '색상이나 채우기에서 범위를 켭니다. 선택에 성공하면 중심이 고정되고 도구에 구가 표시됩니다. 반지름 슬라이더를 놓거나 입력을 마치면 같은 선택이 업데이트됩니다.',
  ],
  'Check keeps the selection and exits. Undo reverses eligible selection history in this session. X clears. Right-click clears, then exits when empty.': [
    'Confirmar conserva la selección y sale. Deshacer revierte el historial de selección válido de esta sesión. X borra la selección. El clic derecho la borra y sale cuando está vacía.',
    'Valider conserve la sélection et quitte l’outil. Annuler revient sur l’historique de sélection admissible de cette session. X efface la sélection. Le clic droit l’efface, puis quitte si elle est vide.',
    'Bestätigen behält die Auswahl und beendet das Werkzeug. Rückgängig kehrt geeignete Auswahlschritte dieser Sitzung um. X leert die Auswahl. Rechtsklick leert sie und beendet das Werkzeug, wenn sie leer ist.',
    'Confirmar mantém a seleção e sai. Desfazer reverte o histórico de seleção válido desta sessão. X limpa a seleção. O clique direito limpa e sai quando ela está vazia.',
    '勾选保留选择并退出。撤销可回退本次会话中符合条件的选择历史。X 清空选择。右键先清空，已为空时则退出。',
    'チェックは選択を保持して終了します。元に戻すは、このセッションで対象となる選択履歴を戻します。X は選択を解除します。右クリックは選択を解除し、空なら終了します。',
    '체크는 선택을 유지하고 종료합니다. 실행 취소는 이 세션에서 해당하는 선택 기록을 되돌립니다. X는 선택을 지웁니다. 오른쪽 클릭은 선택을 지우고, 비어 있으면 종료합니다.',
  ],
  'Reset alignment, axis flips and transforms. An active gizmo session is cancelled first. Use Undo to reverse committed changes.': [
    'Restablece la alineación, los giros de ejes y las transformaciones. Primero se cancela la sesión activa del gizmo. Usa Deshacer para revertir los cambios confirmados.',
    'Réinitialisez l’alignement, les retournements d’axes et les transformations. La session de gizmo active est d’abord annulée. Utilisez Annuler pour revenir sur les modifications validées.',
    'Setzen Sie Ausrichtung, Achsenumkehrungen und Transformationen zurück. Eine aktive Gizmo-Sitzung wird zuerst abgebrochen. Rückgängig macht bestätigte Änderungen rückgängig.',
    'Redefina o alinhamento, as inversões de eixos e as transformações. A sessão ativa do gizmo é cancelada primeiro. Use Desfazer para reverter alterações confirmadas.',
    '重置对齐、轴翻转和变换。活动的操纵器会话会先被取消。使用撤销回退已提交的更改。',
    '位置合わせ、軸の反転、変換をリセットします。操作中のギズモセッションは先に取り消されます。確定済みの変更は元に戻すで戻せます。',
    '정렬, 축 뒤집기, 변환을 초기화합니다. 활성 기즈모 세션을 먼저 취소합니다. 확정한 변경은 실행 취소로 되돌립니다.',
  ],
  'Use the magnet or hold Ctrl (Command on Mac) to snap. Flip X/Y/Z changes orientation. Available in Basic and Pro.': [
    'Usa el imán o mantén Ctrl (Command en Mac) para ajustar a pasos. Invertir X/Y/Z cambia la orientación. Disponible en Básico y Pro.',
    'Utilisez l’aimant ou maintenez Ctrl (Command sur Mac) pour l’accrochage. Retourner X/Y/Z change l’orientation. Disponible en Basique et Pro.',
    'Verwenden Sie den Magneten oder halten Sie Strg (Command auf dem Mac) zum Einrasten. X/Y/Z umkehren ändert die Ausrichtung. In Basic und Pro verfügbar.',
    'Use o ímã ou segure Ctrl (Command no Mac) para ajustar em passos. Inverter X/Y/Z muda a orientação. Disponível em Básico e Pro.',
    '使用磁铁或按住 Ctrl（Mac 上为 Command）进行吸附。翻转 X/Y/Z 可更改朝向。基础和专业模式均可使用。',
    '磁石を使うか Ctrl（Mac では Command）を押してスナップします。X/Y/Z の反転で向きが変わります。Basic と Pro の両方で使えます。',
    '자석을 사용하거나 Ctrl(Mac에서는 Command)을 누르면 스냅됩니다. X/Y/Z 뒤집기로 방향을 바꿉니다. Basic과 Pro에서 모두 사용할 수 있습니다.',
  ],
  'In Pro, enter translation, scale, pivot and rotation values. Distances are in meters. Apply commits the preview; Cancel discards uncommitted values.': [
    'En Pro, introduce valores de traslación, escala, pivote y rotación. Las distancias se expresan en metros. Aplicar confirma la vista previa; Cancelar descarta los valores sin confirmar.',
    'Dans Pro, saisissez translation, échelle, pivot et rotation. Les distances sont en mètres. Appliquer valide l’aperçu ; Annuler abandonne les valeurs non validées.',
    'Geben Sie in Pro Verschiebung, Skalierung, Drehpunkt und Rotation ein. Abstände sind in Metern. Anwenden bestätigt die Vorschau; Abbrechen verwirft unbestätigte Werte.',
    'No Pro, insira translação, escala, pivô e rotação. As distâncias são em metros. Aplicar confirma a prévia; Cancelar descarta valores não confirmados.',
    '在专业模式中输入平移、缩放、枢轴和旋转值。距离单位为米。应用会提交预览；取消会丢弃尚未提交的值。',
    'Pro では移動、スケール、ピボット、回転の値を入力できます。距離の単位はメートルです。適用はプレビューを確定し、キャンセルは未確定の値を破棄します。',
    'Pro에서 이동, 배율, 피벗, 회전 값을 입력합니다. 거리 단위는 미터입니다. 적용은 미리보기를 확정하고 취소는 확정하지 않은 값을 버립니다.',
  ],
  'This control is unavailable in the current view. You can continue the tutorial.': [
    'Este control no está disponible en la vista actual. Puedes continuar el tutorial.',
    'Ce contrôle est indisponible dans la vue actuelle. Vous pouvez poursuivre le tutoriel.',
    'Dieses Steuerelement ist in der aktuellen Ansicht nicht verfügbar. Sie können das Tutorial fortsetzen.',
    'Este controle não está disponível na vista atual. Você pode continuar o tutorial.',
    '此控件在当前视图中不可用。您可以继续教程。',
    '現在のビューではこのコントロールを利用できません。チュートリアルは続行できます。',
    '현재 보기에서는 이 컨트롤을 사용할 수 없습니다. 튜토리얼을 계속 진행할 수 있습니다.',
  ],

  // Current v7 rows supplement the frozen historical catalog. Copyright
  // OpsiClear LLC; LicenseRef-OpsiClear-Proprietary. Exact rows/source lines
  // are pinned in tests/fixtures/tutorial-v7-translations.json. Shared labels
  // Current view only / Duplicate selection reuse the existing control tables.
  // Pinned translations.inc:3
  "Basic has selection, alignment, gizmos and color. Pro adds filters and precise controls. This tour shows Pro without changing your mode.": ["Básico incluye selección, alineación, gizmos y color. Pro añade filtros y controles precisos. El tutorial muestra Pro sin cambiar tu modo.","Basique inclut sélection, alignement, gizmos et couleur. Pro ajoute filtres et réglages précis. La visite affiche Pro sans changer votre mode.","Basic bietet Auswahl, Ausrichtung, Gizmos und Farbe. Pro ergänzt Filter und präzise Steuerung. Die Tour zeigt Pro, ohne Ihren Modus zu ändern.","Básico tem seleção, alinhamento, gizmos e cor. Pro adiciona filtros e controles precisos. O tutorial mostra Pro sem mudar seu modo.","基础版包含选择、对齐、操纵器和颜色。专业版增加筛选器和精确控制。本教程展示专业版，但不会更改您的模式。","Basicは選択、位置合わせ、ギズモ、色を備えます。Proはフィルターと精密設定を追加します。このツアーはモードを変更せずProを表示します。","Basic에는 선택, 정렬, 기즈모, 색상이 있습니다. Pro는 필터와 정밀 제어를 추가합니다. 이 안내는 모드를 바꾸지 않고 Pro를 보여줍니다."],
  // Pinned translations.inc:4
  "All selects every splat. None clears. Invert swaps selected splats.": ["Todo selecciona todos los splats. Ninguno borra la selección. Invertir intercambia la selección.","Tout sélectionne tous les splats. Aucun efface la sélection. Inverser échange les splats sélectionnés.","Alle wählt alle Splats. Keine leert die Auswahl. Umkehren kehrt die Auswahl um.","Tudo seleciona todos os splats. Nenhum limpa a seleção. Inverter troca a seleção.","全选选中所有点。清空取消选择。反选切换选中与未选中的点。","すべてで全スプラットを選択、なしで解除、反転で選択を入れ替えます。","모두는 전체 스플랫을 선택합니다. 없음은 해제합니다. 반전은 선택을 뒤집습니다."],
  // Pinned translations.inc:5
  "Delete and keep": ["Eliminar y conservar","Supprimer et garder","Löschen und behalten","Excluir e manter","删除与保留","削除と保持","삭제와 유지"],
  // Pinned translations.inc:6
  "Delete hides selected splats. Keep hides everything else. Ctrl+Z: undo.": ["Eliminar oculta los splats seleccionados. Conservar oculta el resto. Ctrl+Z: deshacer.","Supprimer masque la sélection. Garder masque tout le reste. Ctrl+Z : annuler.","Löschen blendet ausgewählte Splats aus. Behalten blendet den Rest aus. Strg+Z: rückgängig.","Excluir oculta os splats selecionados. Manter oculta o restante. Ctrl+Z: desfazer.","删除隐藏选中的点。保留隐藏其余点。Ctrl+Z：撤销。","削除は選択部分を非表示に、保持はそれ以外を非表示にします。Ctrl+Z：元に戻す。","삭제는 선택한 스플랫을 숨깁니다. 유지는 나머지를 숨깁니다. Ctrl+Z: 실행 취소."],
  // Pinned translations.inc:7
  "Rotation format": ["Formato de rotación","Format de rotation","Rotationsformat","Formato de rotação","旋转格式","回転形式","회전 형식"],
  // Pinned translations.inc:8
  "Pro: choose Euler angles, quaternion, axis-angle or matrix entry.": ["Pro: elige ángulos de Euler, cuaternión, eje-ángulo o matriz.","Pro : choisissez angles d’Euler, quaternion, axe-angle ou matrice.","Pro: Eulerwinkel, Quaternion, Achse-Winkel oder Matrix wählen.","Pro: escolha ângulos de Euler, quaternion, eixo-ângulo ou matriz.","专业版：选择欧拉角、四元数、轴角或矩阵输入。","Pro：オイラー角、クォータニオン、軸・角度、行列入力を選択。","Pro: 오일러 각도, 쿼터니언, 축-각도 또는 행렬 입력을 선택하세요."],
  // Pinned translations.inc:9
  "Transform axes": ["Ejes de transformación","Axes de transformation","Transformationsachsen","Eixos de transformação","变换坐标轴","変換軸","변환 축"],
  // Pinned translations.inc:10
  "Pro: switch between world and local axes. Basic uses world axes.": ["Pro: cambia entre ejes globales y locales. Básico usa ejes globales.","Pro : basculez entre axes globaux et locaux. Basique utilise les axes globaux.","Pro: zwischen Welt- und lokalen Achsen wechseln. Basic verwendet Weltachsen.","Pro: alterne entre eixos globais e locais. Básico usa eixos globais.","专业版：切换世界与局部坐标轴。基础版使用世界坐标轴。","Pro：ワールド軸とローカル軸を切り替えます。Basicはワールド軸を使用。","Pro: 월드 축과 로컬 축을 전환하세요. Basic은 월드 축을 사용합니다."],
  // Pinned translations.inc:12
  "Transform pivot": ["Pivote de transformación","Pivot de transformation","Transformationsdrehpunkt","Pivô de transformação","变换枢轴","変換ピボット","변환 피벗"],
  // Pinned translations.inc:13
  "Pro: cycle the pivot through scene center, selection center and origin.": ["Pro: alterna el pivote entre centro de escena, centro de selección y origen.","Pro : faites défiler le pivot entre centre de scène, centre de sélection et origine.","Pro: Drehpunkt zwischen Szenenmitte, Auswahlmitte und Ursprung wechseln.","Pro: alterne o pivô entre centro da cena, centro da seleção e origem.","专业版：在场景中心、选区中心和原点之间切换枢轴。","Pro：ピボットをシーン中心、選択中心、原点の順に切り替えます。","Pro: 피벗을 장면 중심, 선택 중심, 원점으로 전환하세요."],
  // Pinned translations.inc:16
  "O: auto orbit. F: flip the camera\u0027s up direction.": ["O: órbita automática. F: invertir la dirección vertical de la cámara.","O : orbite automatique. F : inverser le haut de la caméra.","O: automatischer Orbit. F: Oben-Richtung der Kamera umkehren.","O: órbita automática. F: inverter a direção vertical da câmera.","O：自动环绕。F：翻转相机向上方向。","O：自動周回。F：カメラの上方向を反転。","O: 자동 궤도. F: 카메라의 위 방향 뒤집기."],
  // Pinned translations.inc:19
  "Click the rendered surface to select its strongest splat. Middle-drag to orbit.": ["Pulsa la superficie renderizada para seleccionar el splat dominante. Arrastra con el botón central para orbitar.","Cliquez sur la surface rendue pour sélectionner son splat dominant. Glissez avec le bouton central pour orbiter.","Gerenderte Oberfläche anklicken, um den stärksten Splat zu wählen. Mit der mittleren Taste zum Umkreisen ziehen.","Clique na superfície renderizada para selecionar o splat dominante. Arraste com o botão do meio para orbitar.","点击渲染表面以选择贡献最大的高斯点。按住中键拖动环绕。","描画された表面をクリックし、最も強いスプラットを選択。中ボタンのドラッグで周回します。","렌더링 표면을 클릭해 가장 강한 스플랫을 선택하세요. 가운데 버튼 드래그로 궤도를 돌립니다."],
  // Pinned translations.inc:21
  "Pro: duplicate selected splats, then move the green copy. Editing it turns it yellow.": ["Pro: duplica los splats seleccionados y mueve la copia verde. Al editarla se vuelve amarilla.","Pro : dupliquez les splats sélectionnés, puis déplacez la copie verte. La retoucher la rend jaune.","Pro: ausgewählte Splats duplizieren und die grüne Kopie bewegen. Bearbeiten färbt sie gelb.","Pro: duplique os splats selecionados e mova a cópia verde. Editar a torna amarela.","专业模式：复制选中的高斯点，然后移动绿色副本。编辑后副本变为黄色。","Pro：選択を複製し、緑色のコピーを移動。編集すると黄色になります。","Pro: 선택한 스플랫을 복제하고 초록색 사본을 이동하세요. 편집하면 노란색으로 바뀝니다."],
  // Pinned translations.inc:23
  "Adjust limits or a volume. Volume filters have a target icon to pick the center. Check confirms; Esc restores the starting selection.": ["Ajusta límites o volumen. Los filtros de volumen tienen un objetivo para elegir el centro. La marca confirma; Esc restaura la selección inicial.","Réglez les limites ou le volume. Les filtres de volume ont une cible pour choisir le centre. La coche confirme ; Échap restaure la sélection initiale.","Grenzen oder Volumen anpassen. Volumenfilter haben ein Zielsymbol für die Mitte. Haken bestätigt; Esc stellt die ursprüngliche Auswahl wieder her.","Ajuste limites ou volume. Filtros de volume têm um alvo para escolher o centro. A marca confirma; Esc restaura a seleção inicial.","调整范围或体积。体积筛选器提供靶心图标来拾取中心。勾号确认；Esc 恢复初始选区。","範囲や体積を調整。体積フィルターのターゲットで中心を指定。チェックで確定、Escで開始時の選択に戻ります。","범위나 부피를 조정하세요. 부피 필터의 타깃 아이콘으로 중심을 선택합니다. 체크는 확정, Esc는 시작 선택을 복원합니다."],
  // Pinned translations.inc:24
  "Pro adds gamma, vibrance, tint, shadows, highlights, hue and Fade / boost. They stay active in Basic.": ["Pro añade gamma, intensidad, matiz, sombras, luces, tono y Atenuar / reforzar. Siguen activos en Básico.","Pro ajoute gamma, vibrance, teinte, ombres, hautes lumières, tonalité et Atténuer / renforcer. Ils restent actifs en Basique.","Pro ergänzt Gamma, Dynamik, Tönung, Schatten, Lichter, Farbton und Abschwächen / Verstärken. Sie bleiben in Basic aktiv.","Pro adiciona gama, vibração, matiz, sombras, realces, tom e Atenuar / realçar. Continuam ativos no Básico.","专业模式增加伽马、自然饱和度、色调、阴影、高光、色相和淡化/增强。返回基础模式后仍生效。","Proはガンマ・自然な彩度・色かぶり・シャドウ・ハイライト・色相・フェード/強調を追加。Basicでも有効です。","Pro는 감마, 생동감, 틴트, 그림자, 하이라이트, 색조, 페이드/강화를 추가합니다. 기본 모드에서도 유지됩니다."],
  // Pinned translations.inc:25
  "Color and manual transforms use the selection, or the whole scene when empty. Alignment always moves the whole scene.": ["Color y transformaciones manuales afectan la selección, o toda la escena si no hay selección. La alineación siempre mueve toda la escena.","Couleur et transformations manuelles ciblent la sélection, ou toute la scène si elle est vide. L’alignement déplace toujours toute la scène.","Farbe und manuelle Transformationen betreffen die Auswahl, ohne Auswahl die ganze Szene. Ausrichtung bewegt immer die ganze Szene.","Cor e transformações manuais afetam a seleção, ou toda a cena sem seleção. O alinhamento sempre move toda a cena.","颜色和手动变换作用于选区；未选择时作用于整个场景。对齐始终移动整个场景。","色と手動変形は選択部分に適用。選択がなければシーン全体に適用します。位置合わせは常に全体を動かします。","색상과 수동 변환은 선택 영역에 적용되며, 선택이 없으면 전체 장면에 적용됩니다. 정렬은 항상 전체 장면을 이동합니다."],
  // Pinned translations.inc:27
  "Options follows the tool: size, tolerance, visibility or live selection. Highlighted icons are on.": ["Opciones cambia con la herramienta: tamaño, tolerancia, visibilidad o selección en vivo. Los iconos resaltados están activos.","Options suit l’outil : taille, tolérance, visibilité ou sélection en direct. Les icônes surlignées sont actives.","Optionen folgen dem Werkzeug: Größe, Toleranz, Sichtbarkeit oder Live-Auswahl. Hervorgehobene Symbole sind aktiv.","Opções segue a ferramenta: tamanho, tolerância, visibilidade ou seleção ao vivo. Ícones destacados estão ativos.","选项随工具变化：大小、容差、可见性或实时选择。高亮图标表示开启。","オプションはツールに応じてサイズ・許容値・可視性・ライブ選択を表示。強調されたアイコンはオンです。","옵션은 도구에 따라 크기, 허용 오차, 가시성, 실시간 선택을 표시합니다. 강조된 아이콘은 켜져 있습니다."],
  // Pinned translations.inc:28
  "Finish, undo or clear": ["Finalizar, deshacer o limpiar","Terminer, annuler ou effacer","Abschließen, rückgängig oder leeren","Concluir, desfazer ou limpar","完成、撤销或清空","確定・取り消し・解除","완료, 실행 취소, 해제"],
  // Pinned translations.inc:30
  "Move, rotate and scale": ["Mover, girar y escalar","Déplacer, pivoter et redimensionner","Verschieben, drehen und skalieren","Mover, girar e escalar","移动、旋转和缩放","移動・回転・スケール","이동, 회전, 크기 조절"],
  // Pinned translations.inc:31
  "Choose a gizmo, then drag a handle. Check keeps edits; Undo reverses a drag; X cancels the session.": ["Elige un gizmo y arrastra una manija. La marca conserva los cambios; Deshacer revierte un arrastre; X cancela la sesión.","Choisissez un gizmo et tirez une poignée. La coche garde les modifications ; Annuler retire un geste ; X annule la session.","Gizmo wählen und Griff ziehen. Haken behält Änderungen; Rückgängig entfernt einen Zug; X verwirft die Sitzung.","Escolha um gizmo e arraste uma alça. A marca mantém edições; Desfazer reverte um arrasto; X cancela a sessão.","选择操纵器并拖动手柄。勾号保留编辑，撤销回退一次拖动，X 取消本次操作。","ギズモを選び、ハンドルをドラッグ。チェックは編集を保持、元に戻すはドラッグを取り消し、Xはセッションをキャンセルします。","기즈모를 선택하고 핸들을 드래그하세요. 체크는 편집 유지, 실행 취소는 드래그 되돌리기, X는 세션 취소입니다."],
  // Pinned translations.inc:32
  "Snap and axis flips": ["Ajuste y volteos de ejes","Magnétisme et retournements","Einrasten und Achsen-Flips","Encaixe e inversões de eixos","吸附和轴翻转","スナップと軸反転","스냅과 축 뒤집기"],
  // Pinned translations.inc:647
  "Cycle grid/axes and the black, gray or white background swatch. Guides stay out of saved images.": ["Alterna la cuadrícula/ejes y el fondo negro, gris o blanco. Las guías no salen en las imágenes guardadas.","Faites défiler grille/axes et fond noir, gris ou blanc. Les repères sont exclus des images enregistrées.","Raster/Achsen und schwarzen, grauen oder weißen Hintergrund wechseln. Hilfslinien werden nicht mitgespeichert.","Alterne grade/eixos e fundo preto, cinza ou branco. As guias não aparecem nas imagens salvas.","循环切换网格/坐标轴和黑、灰、白背景。参考线不会出现在保存的图像中。","グリッド／軸と黒・灰・白の背景を切り替えます。ガイドは保存画像に入りません。","격자/축과 검정, 회색, 흰색 배경을 전환하세요. 안내선은 저장한 이미지에 포함되지 않습니다."],
  // Pinned translations.inc:650
  "Selection, Transform and Color tools.": ["Herramientas de Selección, Transformación y Color.","Outils de sélection, transformation et couleur.","Werkzeuge für Auswahl, Transformation und Farbe.","Ferramentas de Seleção, Transformação e Cor.","选择、变换和颜色工具。","選択・変換・カラーのツール。","선택, 변환 및 색상 도구."],
  // Pinned translations.inc:695
  "Toggle the frustum beside Invert to limit selection and selected edits to the current view. Starts off.": ["Activa el frustum junto a Invertir para limitar la selección y sus cambios a la vista actual. Empieza desactivado.","Activez le frustum près d’Inverser pour limiter sélection et retouches à la vue actuelle. Désactivé au départ.","Frustum neben Umkehren aktivieren, um Auswahl und Auswahlbearbeitung auf die aktuelle Ansicht zu begrenzen. Anfangs aus.","Ative o frustum ao lado de Inverter para limitar seleção e suas edições à vista atual. Começa desligado.","切换反选旁的视锥图标，将选择及所选编辑限制在当前视图内。默认关闭。","反転の横の視錐台をオンにすると、選択と選択部分の編集を現在のビューに限定します。初期状態はオフです。","반전 옆 절두체를 켜면 선택과 선택 편집이 현재 보기에 한정됩니다. 처음에는 꺼져 있습니다."],
  // Pinned translations.inc:696
  "Selection range": ["Rango de selección","Portée de sélection","Auswahlbereich","Alcance da seleção","选择范围","選択範囲","선택 범위"],
});
