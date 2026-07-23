import {
  TEAM_CLASSIFICATIONS,
  TEAM_CLASSIFICATION_META,
  type TeamClassificationValue,
} from '../../types/teamClassification';

type Props = {
  value?: TeamClassificationValue;
  onChange: (value: TeamClassificationValue) => void;
  disabled?: boolean;
  ariaLabel?: string;
  compact?: boolean;
};

export default function TeamClassificationSelect({
  value,
  onChange,
  disabled = false,
  ariaLabel = 'Team classification',
  compact = false,
}: Props) {
  return (
    <select
      className={`team-classification-select${compact ? ' compact' : ''}`}
      value={value ?? ''}
      onChange={(event) => onChange((event.target.value || null) as TeamClassificationValue)}
      disabled={disabled}
      aria-label={ariaLabel}
      title={ariaLabel}
    >
      <option value="">Unknown</option>
      {TEAM_CLASSIFICATIONS.map((classification) => (
        <option key={classification} value={classification}>
          {TEAM_CLASSIFICATION_META[classification].label}
        </option>
      ))}
    </select>
  );
}
