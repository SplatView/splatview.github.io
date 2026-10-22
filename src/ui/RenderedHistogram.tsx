import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { AppController } from '../app/controller';
import { useApp } from '../app/store';
import { HISTOGRAM_COLORS, HISTOGRAM_HEIGHT, histogramPaths } from '../renderer/histogram';
import { useTranslation } from '../app/useLanguageAppearance';

export function RenderedHistogram({ controller, visible }: { controller: AppController; visible: boolean }) {
  const { t } = useTranslation();
  const histogram = useApp(state => state.histogram), unavailable = useApp(state => state.histogramUnavailable);
  const container = useRef<HTMLDivElement>(null), [width, setWidth] = useState(274);
  useLayoutEffect(() => {
    const element = container.current!;
    const measure = () => setWidth(Math.max(8, element.getBoundingClientRect().width));
    measure(); const resize = new ResizeObserver(measure); resize.observe(element);
    return () => resize.disconnect();
  }, []);
  useLayoutEffect(() => {
    const element = container.current!;
    let intersects = element.getBoundingClientRect().bottom > 0 && element.getBoundingClientRect().top < innerHeight;
    const update = () => controller.setHistogramVisible(visible && intersects && !document.hidden);
    update();
    const intersection = new IntersectionObserver(entries => { intersects = entries[0].isIntersecting; update(); });
    intersection.observe(element); document.addEventListener('visibilitychange', update);
    return () => {
      intersection.disconnect(); document.removeEventListener('visibilitychange', update);
      controller.setHistogramVisible(false);
    };
  }, [controller, visible]);
  const paths = useMemo(() => histogramPaths(histogram?.bins, width), [histogram, width]);
  return <div ref={container} className="rendered-histogram" data-tutorial-target="histogram" title={t('Rendered RGB (log scale)')}>
    <svg role="img" aria-label={t('Rendered RGB (log scale)')} aria-description={unavailable ? t('Histogram unavailable.') : histogram ?
      t('%u rendered samples per color channel.', histogram.width * histogram.height) : t('Waiting for the rendered view.')}
      viewBox={`0 0 ${width} ${HISTOGRAM_HEIGHT}`} data-frame={histogram?.frame}>
      {paths.map((path, channel) => <path key={channel} d={path} fill="none" stroke={HISTOGRAM_COLORS[channel]}
        strokeOpacity=".82" strokeWidth="1" />)}
    </svg>
  </div>;
}
