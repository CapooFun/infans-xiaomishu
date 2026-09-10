import { useState } from "react";
import { ImageOff } from "lucide-react";

import type { LocalActivityGuideImage } from "../../types";
import { ExternalSourceDisclosure } from "../../page-shared";

type GuideOfficialImageProps = LocalActivityGuideImage & {
  guideId: string;
  className?: string;
  priority?: boolean;
  sourceLink?: boolean;
};

export default function GuideOfficialImage({
  imageUrl,
  imageAlt,
  imageSourceLabel,
  imageSourceUrl,
  imageCredit,
  guideId,
  className = "",
  priority = false,
  sourceLink = false,
}: GuideOfficialImageProps) {
  const [failed, setFailed] = useState(false);
  const showImage = Boolean(imageUrl) && !failed;

  return (
    <figure className={`guide-official-image${className ? ` ${className}` : ""}`}>
      <div className="guide-official-image-frame">
        {showImage ? (
          <img
            src={`/api/tools/local-guide-image?id=${encodeURIComponent(guideId)}`}
            alt={imageAlt}
            loading={priority ? "eager" : "lazy"}
            decoding="async"
            fetchPriority={priority ? "high" : "auto"}
            referrerPolicy="no-referrer"
            onError={() => setFailed(true)}
          />
        ) : (
          <span className="guide-official-image-fallback">
            <ImageOff size={20} aria-hidden="true" />
            <strong>官方内容图暂时不可用</strong>
            <small>攻略正文仍可继续阅读</small>
          </span>
        )}
      </div>
      <figcaption>
        <span>{imageCredit || imageAlt || "官方活动内容图"}</span>
        {sourceLink && imageSourceUrl ? <ExternalSourceDisclosure label="图片来源" sources={[{ label: imageSourceLabel || "官方图片来源", url: imageSourceUrl }]} /> : <small>{imageSourceLabel || "官方图片来源"}</small>}
      </figcaption>
    </figure>
  );
}
