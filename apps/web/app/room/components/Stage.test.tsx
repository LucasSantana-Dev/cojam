import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { Stage } from './Stage';

describe('Stage', () => {
  it('renders the media child inside a labelled landmark', () => {
    render(
      <Stage label="Video stage">
        <div data-testid="media" />
      </Stage>,
    );
    expect(screen.getByRole('region', { name: 'Video stage' })).toContainElement(screen.getByTestId('media'));
  });

  it('omits overlay and caption unless given', () => {
    render(
      <Stage>
        <div />
      </Stage>,
    );
    expect(screen.queryByTestId('stage-overlay')).toBeNull();
    expect(screen.queryByTestId('stage-caption')).toBeNull();
  });

  it('mounts overlay over the frame and caption under it, so any media can reuse it', () => {
    render(
      <Stage overlay={<span>live</span>} caption={<span>Title</span>}>
        <video data-testid="media" />
      </Stage>,
    );
    const frame = screen.getByTestId('media').parentElement!;
    expect(frame).toHaveClass('stage-frame');
    expect(frame).toContainElement(screen.getByTestId('stage-overlay'));
    expect(frame).not.toContainElement(screen.getByTestId("stage-caption"));
  });
});
