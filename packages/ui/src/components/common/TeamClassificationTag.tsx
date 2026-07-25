import {
  TEAM_CLASSIFICATION_META,
  type TeamClassificationKey,
} from '../../types/teamClassification';

interface TeamClassificationTagProps {
  classification: TeamClassificationKey;
}

export default function TeamClassificationTag({
  classification,
}: TeamClassificationTagProps) {
  return (
    <span className={`v8-space-tag ${classification}`}>
      <i />
      {TEAM_CLASSIFICATION_META[classification].short}
    </span>
  );
}
