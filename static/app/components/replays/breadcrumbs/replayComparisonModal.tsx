import {useEffect, useState} from 'react';
import styled from '@emotion/styled';
import {DiffEditor} from '@monaco-editor/react';
import beautify from 'js-beautify';

import {ModalRenderProps} from 'sentry/actionCreators/modal';
import {Flex} from 'sentry/components/profiling/flex';
import {
  Provider as ReplayContextProvider,
  useReplayContext,
} from 'sentry/components/replays/replayContext';
import ReplayPlayer from 'sentry/components/replays/replayPlayer';
import {TabList} from 'sentry/components/tabs';
import {t} from 'sentry/locale';
import ConfigStore from 'sentry/stores/configStore';
import {useLegacyStore} from 'sentry/stores/useLegacyStore';
import {space} from 'sentry/styles/space';
import {Organization} from 'sentry/types';
import ReplayReader from 'sentry/utils/replays/replayReader';
import {OrganizationContext} from 'sentry/views/organizationContext';

interface Props extends ModalRenderProps {
  leftTimestamp: number;
  organization: Organization;
  replay: null | ReplayReader;
  rightTimestamp: number;
}

export default function ReplayComparisonModal({
  Body,
  Header,
  leftTimestamp,
  organization,
  replay,
  rightTimestamp,
}: Props) {
  const fetching = false;

  const config = useLegacyStore(ConfigStore);
  const isDark = config.theme === 'dark';

  const [activeTab, setActiveTab] = useState<'visual' | 'html'>('html');

  const [leftBody, setLeftBody] = useState(null);
  const [rightBody, setRightBody] = useState(null);

  return (
    <OrganizationContext.Provider value={organization}>
      <Header closeButton>
        <h4>{t('Hydration Error')}</h4>
      </Header>
      <Body>
        <Flex gap={space(2)} column>
          <TabList
            hideBorder
            selectedKey={activeTab}
            onSelectionChange={tab => setActiveTab(tab as 'visual' | 'html')}
          >
            <TabList.Item key="html">Html Diff</TabList.Item>
            <TabList.Item key="visual">Visual Diff</TabList.Item>
          </TabList>
          <Flex
            gap={space(2)}
            style={{
              // Using css to hide since the splitdiff uses the html from the iframes
              // TODO: This causes a bit of a flash when switching tabs
              display: activeTab === 'visual' ? undefined : 'none',
            }}
          >
            <ReplayContextProvider
              isFetching={fetching}
              replay={replay}
              initialTimeOffsetMs={{offsetMs: leftTimestamp - 1}}
            >
              <ComparisonSideWrapper id="leftSide">
                <ReplaySide
                  selector="#leftSide iframe"
                  expectedTime={leftTimestamp - 1}
                  onLoad={setLeftBody}
                />
              </ComparisonSideWrapper>
            </ReplayContextProvider>
            <ReplayContextProvider
              isFetching={fetching}
              replay={replay}
              initialTimeOffsetMs={{offsetMs: rightTimestamp + 1}}
            >
              <ComparisonSideWrapper id="rightSide">
                <ReplaySide
                  selector="#rightSide iframe"
                  expectedTime={rightTimestamp + 1}
                  onLoad={setRightBody}
                />
              </ComparisonSideWrapper>
            </ReplayContextProvider>
          </Flex>
          {activeTab === 'html' && leftBody && rightBody ? (
            <div>
              <DiffEditor
                height="60vh"
                theme={isDark ? 'vs-dark' : 'light'}
                language="html"
                original={leftBody}
                modified={rightBody}
                options={{
                  // Options - https://microsoft.github.io/monaco-editor/typedoc/interfaces/editor.IDiffEditorConstructionOptions.html
                  scrollBeyondLastLine: false,
                  readOnly: true,
                }}
              />
            </div>
          ) : null}
        </Flex>
      </Body>
    </OrganizationContext.Provider>
  );
}

function ReplaySide({expectedTime, selector, onLoad}) {
  const {currentTime} = useReplayContext();

  useEffect(() => {
    if (currentTime === expectedTime) {
      setTimeout(() => {
        const iframe = document.querySelector(selector) as HTMLIFrameElement;
        const body = iframe.contentWindow?.document.body;
        if (body) {
          onLoad(
            beautify.html(body.innerHTML, {
              indent_size: 2,
              wrap_line_length: 80,
            })
          );
        }
      }, 0);
    }
  }, [currentTime, expectedTime, selector, onLoad]);
  return <ReplayPlayer isPreview />;
}

const ComparisonSideWrapper = styled('div')`
  display: contents;
  flex-grow: 1;
  max-width: 50%;
`;
