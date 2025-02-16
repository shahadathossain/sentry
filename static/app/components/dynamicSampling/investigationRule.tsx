import styled from '@emotion/styled';
import moment from 'moment';

import {addErrorMessage, addSuccessMessage} from 'sentry/actionCreators/indicator';
import Feature from 'sentry/components/acl/feature';
import {BaseButtonProps, Button} from 'sentry/components/button';
import ExternalLink from 'sentry/components/links/externalLink';
import {Tooltip} from 'sentry/components/tooltip';
import {IconQuestion, IconStack} from 'sentry/icons';
import {t, tct} from 'sentry/locale';
import {space} from 'sentry/styles/space';
import {Organization} from 'sentry/types';
import {trackAnalytics} from 'sentry/utils/analytics';
import EventView from 'sentry/utils/discover/eventView';
import {
  ApiQueryKey,
  useApiQuery,
  useMutation,
  useQueryClient,
} from 'sentry/utils/queryClient';
import RequestError from 'sentry/utils/requestError/requestError';
import useApi from 'sentry/utils/useApi';
import useOrganization from 'sentry/utils/useOrganization';

// Number of samples under which we can trigger an investigation rule
const INVESTIGATION_MAX_SAMPLES_TRIGGER = 5;

type Props = {
  buttonProps: BaseButtonProps;
  eventView: EventView;
  numSamples: number | null | undefined;
};

type PropsInternal = Props & {
  organization: Organization;
};

type CustomDynamicSamplingRule = {
  condition: Record<string, any>;
  dateAdded: string;
  endDate: string;
  numSamples: number;
  orgId: string;
  projects: number[];
  ruleId: number;
  sampleRate: number;
  startDate: string;
};
type CreateCustomRuleVariables = {
  organization: Organization;
  period: string | null;
  projects: number[];
  query: string;
};

function makeRuleExistsQueryKey(
  query: string,
  projects: number[],
  organization: Organization
): ApiQueryKey {
  // sort the projects to keep the query key invariant to the order of the projects
  const sortedProjects = [...projects].sort();
  return [
    `/organizations/${organization.slug}/dynamic-sampling/custom-rules/`,
    {
      query: {
        project: sortedProjects,
        query,
      },
    },
  ];
}

function hasTooFewSamples(numSamples: number | null | undefined) {
  // check if we have got the samples, but there are too few of them
  return (
    numSamples !== null &&
    numSamples !== undefined &&
    numSamples < INVESTIGATION_MAX_SAMPLES_TRIGGER
  );
}

function useGetExistingRule(
  query: string,
  projects: number[],
  organization: Organization,
  numSamples: number | null | undefined
) {
  const enabled = hasTooFewSamples(numSamples);

  const result = useApiQuery<CustomDynamicSamplingRule | '' | null>(
    makeRuleExistsQueryKey(query, projects, organization),
    {
      staleTime: 0,
      enabled,
      // No retries for 4XX errors.
      // This makes the error feedback a lot faster, and there is no unnecessary network traffic.
      retry: (failureCount, error) => {
        if (failureCount >= 2) {
          return false;
        }
        if (error.status && error.status >= 400 && error.status < 500) {
          // don't retry 4xx errors (in theory 429 should be retried but not immediately)
          return false;
        }
        return true;
      },
    }
  );

  if (result.data === '') {
    // cleanup, the endpoint returns a 204 (with no body), change it to null
    result.data = null;
  }

  return result;
}

function useCreateInvestigationRuleMutation(vars: CreateCustomRuleVariables) {
  const api = useApi();
  const queryClient = useQueryClient();
  const {mutate} = useMutation<
    CustomDynamicSamplingRule,
    RequestError,
    CreateCustomRuleVariables
  >({
    mutationFn: (variables: CreateCustomRuleVariables) => {
      const {organization} = variables;
      const endpoint = `/organizations/${organization.slug}/dynamic-sampling/custom-rules/`;
      return api.requestPromise(endpoint, {
        method: 'POST',
        data: variables,
      });
    },
    onSuccess: (_data: CustomDynamicSamplingRule) => {
      addSuccessMessage(t('Successfully created investigation rule'));
      // invalidate the rule-exists query
      queryClient.invalidateQueries(
        makeRuleExistsQueryKey(vars.query, vars.projects, vars.organization)
      );
      trackAnalytics('dynamic_sampling.custom_rule_add', {
        organization: vars.organization,
        projects: vars.projects,
        query: vars.query,
        success: true,
      });
    },
    onError: (_error: RequestError) => {
      if (_error.status === 429) {
        addErrorMessage(
          t(
            'You have reached the maximum number of concurrent investigation rules allowed'
          )
        );
      } else {
        addErrorMessage(t('Unable to create investigation rule'));
      }

      trackAnalytics('dynamic_sampling.custom_rule_add', {
        organization: vars.organization,
        projects: vars.projects,
        query: vars.query,
        success: false,
      });
    },
    retry: false,
  });
  return mutate;
}

const InvestigationInProgressNotification = styled('span')`
  font-size: ${p => p.theme.fontSizeMedium};
  color: ${p => p.theme.subText};
  font-weight: 600;
  display: inline-flex;
  align-items: center;
  gap: ${space(0.5)};
`;

function handleRequestError(error: RequestError) {
  // check why it failed (if it is due to the fact that the query is not supported (e.g. non transaction query)
  // do nothing we just don't show the button
  if (error.responseJSON?.query) {
    const query = error.responseJSON.query;
    if (Array.isArray(query)) {
      for (const reason of query) {
        if (reason === 'not_transaction_query') {
          return; // this is not an error we just don't show the button
        }
      }
    }
  }
  const errorResponse = t('Unable to fetch investigation rule');
  addErrorMessage(errorResponse);
}

function InvestigationRuleCreationInternal(props: PropsInternal) {
  const projects = [...props.eventView.project];
  const organization = props.organization;
  const period = props.eventView.statsPeriod || null;
  const query = props.eventView.getQuery();
  const createInvestigationRule = useCreateInvestigationRuleMutation({
    query,
    projects,
    organization,
    period,
  });
  const request = useGetExistingRule(query, projects, organization, props.numSamples);

  if (!hasTooFewSamples(props.numSamples)) {
    // no results yet (we can't take a decision) or enough results,
    // we don't need investigation rule UI
    return null;
  }
  if (request.isLoading) {
    return null;
  }
  if (request.isError) {
    handleRequestError(request.error);
    return null;
  }

  const rule = request.data;
  const haveInvestigationRuleInProgress = !!rule;

  if (haveInvestigationRuleInProgress) {
    // investigation rule in progress, just show a message
    const existingRule = rule as CustomDynamicSamplingRule;
    const ruleStartDate = new Date(existingRule.startDate);
    const now = new Date();
    const interval = moment.duration(now.getTime() - ruleStartDate.getTime()).humanize();

    return (
      <InvestigationInProgressNotification>
        {tct('Collecting samples since [interval]  ago.', {interval})}

        <Tooltip
          isHoverable
          title={tct(
            'A user has temporarily adjusted retention priorities, increasing the odds of getting events matching your search query. [link:Learn more.]',
            // TODO find out where this link is pointing to
            {
              link: <ExternalLink href="https://docs.sentry.io" />,
            }
          )}
        >
          <StyledIconQuestion size="sm" color="subText" />
        </Tooltip>
      </InvestigationInProgressNotification>
    );
  }

  // no investigation rule in progress, show a button to create one
  return (
    <Tooltip
      isHoverable
      title={tct(
        'We can find more events that match your search query by adjusting your retention priorities for an hour, increasing the odds of getting matching events. [link:Learn more.]',
        // TODO find out where this link is pointing to
        {
          link: <ExternalLink href="https://docs.sentry.io" />,
        }
      )}
    >
      <Button
        priority="primary"
        {...props.buttonProps}
        onClick={() => createInvestigationRule({organization, period, projects, query})}
        icon={<IconStack />}
      >
        {t('Get Samples')}
      </Button>
    </Tooltip>
  );
}

export function InvestigationRuleCreation(props: Props) {
  const organization = useOrganization();
  return (
    <Feature features="investigation-bias">
      <InvestigationRuleCreationInternal {...props} organization={organization} />
    </Feature>
  );
}

const StyledIconQuestion = styled(IconQuestion)`
  position: relative;
  top: 2px;
`;
